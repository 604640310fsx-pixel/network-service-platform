#define _DARWIN_C_SOURCE 1

#include "local_opaque_operation_broker_core.h"
#include "local_opaque_operation_broker_ipc.h"
#include "local_opaque_operation_broker_native.h"

#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecCode.h>
#include <Security/SecRequirement.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <grp.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#include <xpc/xpc.h>

#define MOB_CLIENT_IDENTIFIER_MAX_BYTES 255U
#define MOB_CLIENT_TEAM_ID_MAX_BYTES 127U
#define MOB_CLIENT_CDHASH_MAX_BYTES 32U
#define MOB_CLIENT_REQUIREMENT_MAX_BYTES 8192U
typedef struct {
    uid_t authorized_caller_uid;
    char client_identifier[MOB_CLIENT_IDENTIFIER_MAX_BYTES + 1U];
    char client_team_id[MOB_CLIENT_TEAM_ID_MAX_BYTES + 1U];
    uint8_t client_cdhash[MOB_CLIENT_CDHASH_MAX_BYTES];
    size_t client_cdhash_length;
    CFDataRef client_requirement_data;
    SecRequirementRef client_requirement;
} mob_service_config;

static mob_service_config mob_config;
static dispatch_queue_t mob_operation_queue;
static xpc_connection_t mob_active_connection;
static bool mob_operation_active;
static _Atomic bool mob_operation_cancelled;
static mob_native_rate_state mob_rate_state;

static void mob_wipe(void *value, size_t length) {
    volatile uint8_t *cursor = (volatile uint8_t *)value;
    while (length > 0U) {
        *cursor++ = 0U;
        --length;
    }
}

static bool mob_ascii_token(const char *value, size_t capacity) {
    size_t index;
    const size_t length = value == NULL ? 0U : strlen(value);
    if (length == 0U || length >= capacity || strchr(value, '@') != NULL) {
        return false;
    }
    for (index = 0U; index < length; ++index) {
        const unsigned char character = (unsigned char)value[index];
        if (!((character >= 'A' && character <= 'Z') ||
              (character >= 'a' && character <= 'z') ||
              (character >= '0' && character <= '9') ||
              character == '.' || character == '-')) {
            return false;
        }
    }
    return true;
}

static bool mob_parse_uid(const char *value, uid_t *uid) {
    unsigned long parsed;
    char *end = NULL;
    size_t index;
    const size_t length = value == NULL ? 0U : strlen(value);
    if (uid == NULL || length == 0U || length > 10U ||
        (length > 1U && value[0] == '0')) {
        return false;
    }
    for (index = 0U; index < length; ++index) {
        if (value[index] < '0' || value[index] > '9') {
            return false;
        }
    }
    errno = 0;
    parsed = strtoul(value, &end, 10);
    if (errno != 0 || end == NULL || *end != '\0' || parsed == 0UL ||
        parsed > (unsigned long)UINT_MAX) {
        return false;
    }
    *uid = (uid_t)parsed;
    return true;
}

static int mob_hex_nibble(char character) {
    if (character >= '0' && character <= '9') {
        return character - '0';
    }
    if (character >= 'a' && character <= 'f') {
        return character - 'a' + 10;
    }
    if (character >= 'A' && character <= 'F') {
        return character - 'A' + 10;
    }
    return -1;
}

static bool mob_decode_cdhash(
    const char *value,
    uint8_t output[MOB_CLIENT_CDHASH_MAX_BYTES],
    size_t *output_length
) {
    size_t index;
    const size_t length = value == NULL ? 0U : strlen(value);
    if (output == NULL || output_length == NULL ||
        (length != 40U && length != 64U)) {
        return false;
    }
    for (index = 0U; index < length / 2U; ++index) {
        const int high = mob_hex_nibble(value[index * 2U]);
        const int low = mob_hex_nibble(value[index * 2U + 1U]);
        if (high < 0 || low < 0) {
            return false;
        }
        output[index] = (uint8_t)((high << 4) | low);
    }
    *output_length = length / 2U;
    return true;
}

static int mob_base64_value(char character) {
    if (character >= 'A' && character <= 'Z') {
        return character - 'A';
    }
    if (character >= 'a' && character <= 'z') {
        return character - 'a' + 26;
    }
    if (character >= '0' && character <= '9') {
        return character - '0' + 52;
    }
    if (character == '+') {
        return 62;
    }
    if (character == '/') {
        return 63;
    }
    return -1;
}

static bool mob_decode_base64(
    const char *value,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_length
) {
    size_t input_offset;
    size_t output_offset = 0U;
    const size_t length = value == NULL ? 0U : strlen(value);
    if (output == NULL || output_length == NULL || length == 0U ||
        length % 4U != 0U || length > 4U * ((output_capacity + 2U) / 3U)) {
        return false;
    }
    for (input_offset = 0U; input_offset < length; input_offset += 4U) {
        int decoded[4];
        size_t index;
        unsigned int padding = 0U;
        for (index = 0U; index < 4U; ++index) {
            const char character = value[input_offset + index];
            if (character == '=') {
                if (input_offset + 4U != length || index < 2U) {
                    return false;
                }
                decoded[index] = 0;
                ++padding;
            } else {
                if (padding != 0U) {
                    return false;
                }
                decoded[index] = mob_base64_value(character);
                if (decoded[index] < 0) {
                    return false;
                }
            }
        }
        if (padding > 2U || output_offset > output_capacity ||
            3U - padding > output_capacity - output_offset) {
            return false;
        }
        output[output_offset++] = (uint8_t)((decoded[0] << 2) | (decoded[1] >> 4));
        if (padding < 2U) {
            output[output_offset++] = (uint8_t)((decoded[1] << 4) | (decoded[2] >> 2));
        }
        if (padding == 0U) {
            output[output_offset++] = (uint8_t)((decoded[2] << 6) | decoded[3]);
        }
    }
    *output_length = output_offset;
    return output_offset > 0U;
}

static bool mob_parse_service_config(int argc, char **argv) {
    uint8_t requirement_bytes[MOB_CLIENT_REQUIREMENT_MAX_BYTES];
    size_t requirement_length = 0U;
    bool valid = false;
    memset(&mob_config, 0, sizeof(mob_config));
    memset(requirement_bytes, 0, sizeof(requirement_bytes));
    if (argc != 13 || argv == NULL || argv[0] == NULL ||
        strcmp(argv[0], MOB_SERVICE_PATH) != 0 ||
        strcmp(argv[1], "--authorized-caller-uid") != 0 ||
        strcmp(argv[3], "--client-path") != 0 || strcmp(argv[4], MOB_CLIENT_PATH) != 0 ||
        strcmp(argv[5], "--client-identifier") != 0 ||
        strcmp(argv[7], "--client-team-id") != 0 ||
        strcmp(argv[9], "--client-cdhash") != 0 ||
        strcmp(argv[11], "--client-requirement-b64") != 0 ||
        !mob_parse_uid(argv[2], &mob_config.authorized_caller_uid) ||
        !mob_native_connection_euid_allowed(
            mob_config.authorized_caller_uid,
            mob_config.authorized_caller_uid,
            geteuid()) ||
        !mob_ascii_token(argv[6], sizeof(mob_config.client_identifier)) ||
        !mob_ascii_token(argv[8], sizeof(mob_config.client_team_id)) ||
        !mob_decode_cdhash(
            argv[10],
            mob_config.client_cdhash,
            &mob_config.client_cdhash_length) ||
        strchr(argv[12], '@') != NULL ||
        !mob_decode_base64(
            argv[12],
            requirement_bytes,
            sizeof(requirement_bytes),
            &requirement_length)) {
        goto done;
    }
    memcpy(mob_config.client_identifier, argv[6], strlen(argv[6]) + 1U);
    memcpy(mob_config.client_team_id, argv[8], strlen(argv[8]) + 1U);
    mob_config.client_requirement_data = CFDataCreate(
        kCFAllocatorDefault,
        requirement_bytes,
        (CFIndex)requirement_length);
    if (mob_config.client_requirement_data == NULL ||
        SecRequirementCreateWithData(
            mob_config.client_requirement_data,
            kSecCSDefaultFlags,
            &mob_config.client_requirement) != errSecSuccess ||
        mob_config.client_requirement == NULL) {
        goto done;
    }
    valid = true;
done:
    mob_wipe(requirement_bytes, sizeof(requirement_bytes));
    return valid;
}

static bool mob_service_account_is_exact(void) {
    struct passwd *account;
    gid_t groups[32];
    int group_count;
    if (geteuid() == 0U || getegid() == 0U) {
        return false;
    }
    account = getpwuid(geteuid());
    if (account == NULL || account->pw_name == NULL || account->pw_dir == NULL ||
        account->pw_shell == NULL || strcmp(account->pw_name, MOB_SERVICE_ACCOUNT) != 0 ||
        strcmp(account->pw_dir, "/var/empty") != 0 ||
        strcmp(account->pw_shell, "/usr/bin/false") != 0 || account->pw_gid != getegid()) {
        return false;
    }
    group_count = getgroups((int)(sizeof(groups) / sizeof(groups[0])), groups);
    return group_count == 1 && groups[0] == getegid();
}

static bool mob_extended_acl_is_absent(const char *path) {
    struct stat before;
    struct stat after;
    acl_t acl;
    int acl_errno;
    if (path == NULL || lstat(path, &before) != 0) {
        return false;
    }
    errno = 0;
    acl = acl_get_link_np(path, ACL_TYPE_EXTENDED);
    acl_errno = errno;
    if (acl != NULL) {
        acl_free(acl);
        return false;
    }
    if (acl_errno != ENOENT || lstat(path, &after) != 0) {
        return false;
    }
    return before.st_dev == after.st_dev && before.st_ino == after.st_ino &&
           before.st_mode == after.st_mode && before.st_uid == after.st_uid &&
           before.st_gid == after.st_gid;
}

static bool mob_secure_root_owned_component(const char *path, bool regular) {
    struct stat metadata;
    if (path == NULL || lstat(path, &metadata) != 0 || metadata.st_uid != 0U ||
        (metadata.st_mode & (S_IWGRP | S_IWOTH | S_ISUID | S_ISGID)) != 0U ||
        !mob_extended_acl_is_absent(path)) {
        return false;
    }
    return regular ? S_ISREG(metadata.st_mode) : S_ISDIR(metadata.st_mode);
}

static bool mob_secure_client_path(const char *path) {
    char copy[PATH_MAX];
    char *separator;
    if (path == NULL || strcmp(path, MOB_CLIENT_PATH) != 0 ||
        strlen(path) >= sizeof(copy) || !mob_secure_root_owned_component("/", false) ||
        !mob_secure_root_owned_component(path, true)) {
        return false;
    }
    memcpy(copy, path, strlen(path) + 1U);
    separator = copy + 1;
    while ((separator = strchr(separator, '/')) != NULL) {
        *separator = '\0';
        if (!mob_secure_root_owned_component(copy, false)) {
            return false;
        }
        *separator = '/';
        ++separator;
    }
    return true;
}

static bool mob_cfstring_equals_cstring(CFTypeRef value, const char *expected) {
    char buffer[MOB_CLIENT_IDENTIFIER_MAX_BYTES + 1U];
    if (value == NULL || expected == NULL || CFGetTypeID(value) != CFStringGetTypeID() ||
        !CFStringGetCString(
            (CFStringRef)value,
            buffer,
            (CFIndex)sizeof(buffer),
            kCFStringEncodingUTF8)) {
        return false;
    }
    return strcmp(buffer, expected) == 0;
}

static bool mob_cdhashes_contain(CFTypeRef value) {
    CFIndex index;
    if (value == NULL || CFGetTypeID(value) != CFArrayGetTypeID()) {
        return false;
    }
    for (index = 0; index < CFArrayGetCount((CFArrayRef)value); ++index) {
        CFTypeRef candidate = CFArrayGetValueAtIndex((CFArrayRef)value, index);
        if (candidate != NULL && CFGetTypeID(candidate) == CFDataGetTypeID() &&
            (size_t)CFDataGetLength((CFDataRef)candidate) == mob_config.client_cdhash_length &&
            memcmp(
                CFDataGetBytePtr((CFDataRef)candidate),
                mob_config.client_cdhash,
                mob_config.client_cdhash_length) == 0) {
            return true;
        }
    }
    return false;
}

static bool mob_get_task_allow_is_safe(CFDictionaryRef signing) {
    CFTypeRef entitlements = CFDictionaryGetValue(signing, kSecCodeInfoEntitlementsDict);
    CFTypeRef get_task_allow;
    if (entitlements == NULL) {
        return true;
    }
    if (CFGetTypeID(entitlements) != CFDictionaryGetTypeID()) {
        return false;
    }
    get_task_allow = CFDictionaryGetValue(
        (CFDictionaryRef)entitlements,
        CFSTR("com.apple.security.get-task-allow"));
    return get_task_allow == NULL ||
           (CFGetTypeID(get_task_allow) == CFBooleanGetTypeID() &&
            !CFBooleanGetValue((CFBooleanRef)get_task_allow));
}

static bool mob_attest_request_message(
    xpc_object_t message,
    mob_native_peer_evidence *result
) {
    SecCodeRef peer_code = NULL;
    CFURLRef peer_path = NULL;
    CFDictionaryRef signing = NULL;
    SecRequirementRef designated_requirement = NULL;
    CFDataRef designated_requirement_data = NULL;
    CFTypeRef flags_value;
    CFTypeRef unique_value;
    uint32_t flags = 0U;
    char path[PATH_MAX];
    mob_native_peer_evidence evidence;
    bool valid;
    if (result == NULL) {
        return false;
    }
    memset(&evidence, 0, sizeof(evidence));
    memset(result, 0, sizeof(*result));
    if (SecCodeCreateWithXPCMessage(
            message,
            kSecCSDefaultFlags,
            &peer_code) != errSecSuccess || peer_code == NULL) {
        goto done;
    }
    evidence.message_code_created = true;
    evidence.dynamic_validity_passed = SecCodeCheckValidity(
        peer_code,
        kSecCSStrictValidate,
        mob_config.client_requirement) == errSecSuccess;
    if (!evidence.dynamic_validity_passed ||
        SecCodeCopyPath(
            (SecStaticCodeRef)peer_code,
            kSecCSDefaultFlags,
            &peer_path) != errSecSuccess || peer_path == NULL ||
        !CFURLGetFileSystemRepresentation(
            peer_path,
            true,
            (UInt8 *)path,
            (CFIndex)sizeof(path))) {
        goto done;
    }
    evidence.exact_path_passed = strcmp(path, MOB_CLIENT_PATH) == 0;
    evidence.secure_path_passed = evidence.exact_path_passed && mob_secure_client_path(path);
    if (!evidence.secure_path_passed ||
        SecCodeCopySigningInformation(
            (SecStaticCodeRef)peer_code,
            kSecCSSigningInformation | kSecCSRequirementInformation |
                kSecCSDynamicInformation,
            &signing) != errSecSuccess || signing == NULL) {
        goto done;
    }
    flags_value = CFDictionaryGetValue(signing, kSecCodeInfoFlags);
    unique_value = CFDictionaryGetValue(signing, kSecCodeInfoUnique);
    if (flags_value != NULL && CFGetTypeID(flags_value) == CFNumberGetTypeID() &&
        CFNumberGetValue((CFNumberRef)flags_value, kCFNumberSInt32Type, &flags)) {
        evidence.hardened_runtime_present = (flags & kSecCodeSignatureRuntime) != 0U;
        evidence.ad_hoc_absent = (flags & kSecCodeSignatureAdhoc) == 0U;
    }
    evidence.identifier_passed = mob_cfstring_equals_cstring(
        CFDictionaryGetValue(signing, kSecCodeInfoIdentifier),
        mob_config.client_identifier);
    evidence.team_identifier_passed = mob_cfstring_equals_cstring(
        CFDictionaryGetValue(signing, kSecCodeInfoTeamIdentifier),
        mob_config.client_team_id);
    evidence.cdhash_passed = unique_value != NULL &&
        CFGetTypeID(unique_value) == CFDataGetTypeID() &&
        (size_t)CFDataGetLength((CFDataRef)unique_value) == mob_config.client_cdhash_length &&
        memcmp(
            CFDataGetBytePtr((CFDataRef)unique_value),
            mob_config.client_cdhash,
            mob_config.client_cdhash_length) == 0 &&
        mob_cdhashes_contain(CFDictionaryGetValue(signing, kSecCodeInfoCdHashes));
    evidence.get_task_allow_safe = mob_get_task_allow_is_safe(signing);
    if (SecCodeCopyDesignatedRequirement(
            (SecStaticCodeRef)peer_code,
            kSecCSDefaultFlags,
            &designated_requirement) == errSecSuccess && designated_requirement != NULL &&
        SecRequirementCopyData(
            designated_requirement,
            kSecCSDefaultFlags,
            &designated_requirement_data) == errSecSuccess &&
        designated_requirement_data != NULL) {
        evidence.designated_requirement_passed = CFEqual(
            designated_requirement_data,
            mob_config.client_requirement_data);
    }
done:
    valid = mob_native_peer_evidence_valid(&evidence);
    *result = evidence;
    mob_wipe(path, sizeof(path));
    if (designated_requirement_data != NULL) {
        CFRelease(designated_requirement_data);
    }
    if (designated_requirement != NULL) {
        CFRelease(designated_requirement);
    }
    if (signing != NULL) {
        CFRelease(signing);
    }
    if (peer_path != NULL) {
        CFRelease(peer_path);
    }
    if (peer_code != NULL) {
        CFRelease(peer_code);
    }
    return valid;
}

static double mob_monotonic_seconds(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) {
        return -1.0;
    }
    return (double)value.tv_sec + ((double)value.tv_nsec / 1000000000.0);
}

static bool mob_rate_gate_accept(void) {
    const double now = mob_monotonic_seconds();
    return mob_native_rate_gate_accept(&mob_rate_state, mob_operation_active, now);
}

bool mob_native_platform_cancelled(void) {
    return atomic_load_explicit(&mob_operation_cancelled, memory_order_relaxed);
}

static void mob_cancel_rejected_connection(xpc_connection_t connection) {
    if (connection != NULL) {
        xpc_connection_cancel(connection);
    }
}

static void mob_handle_connection(xpc_connection_t connection) {
    const uid_t peer_euid = xpc_connection_get_euid(connection);
    __block bool request_seen = false;
    xpc_connection_set_target_queue(connection, dispatch_get_main_queue());
    if (!mob_native_connection_euid_allowed(
            peer_euid,
            mob_config.authorized_caller_uid,
            geteuid())) {
        xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
            (void)event;
        });
        xpc_connection_resume(connection);
        mob_cancel_rejected_connection(connection);
        return;
    }
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_ERROR) {
            if (mob_active_connection == connection) {
                atomic_store_explicit(
                    &mob_operation_cancelled,
                    true,
                    memory_order_relaxed);
            }
            return;
        }
        if (!mob_native_request_once(&request_seen)) {
            mob_cancel_rejected_connection(connection);
            return;
        }
        mob_native_peer_evidence evidence;
        const bool schema_valid = mob_ipc_request_is_exact(event);
        memset(&evidence, 0, sizeof(evidence));
        if (schema_valid) {
            (void)mob_attest_request_message(event, &evidence);
        }
        if (!mob_native_peer_request_authorized(
                peer_euid,
                mob_config.authorized_caller_uid,
                geteuid(),
                schema_valid,
                &evidence) ||
            !mob_rate_gate_accept()) {
            mob_cancel_rejected_connection(connection);
            return;
        }
        mob_operation_active = true;
        atomic_store_explicit(&mob_operation_cancelled, false, memory_order_relaxed);
        mob_active_connection = xpc_retain(connection);
        xpc_object_t retained_message = xpc_retain(event);
        xpc_connection_t retained_connection = xpc_retain(connection);
        dispatch_async(mob_operation_queue, ^{
            char result[MOB_IPC_RESULT_MAX_BYTES];
            size_t result_length = 0U;
            const char *selected = result;
            xpc_object_t response;
            bool produced = mob_native_execute_operation(
                peer_euid,
                result,
                sizeof(result),
                &result_length);
            if (!produced || !mob_validate_parent_json(result, result_length)) {
                selected = MOB_INTERNAL_FAILURE_JSON;
                result_length = strlen(MOB_INTERNAL_FAILURE_JSON);
            }
            response = mob_ipc_create_response(
                retained_message,
                selected,
                result_length);
            if (response != NULL) {
                xpc_connection_send_message(retained_connection, response);
                xpc_release(response);
            }
            mob_wipe(result, sizeof(result));
            xpc_connection_cancel(retained_connection);
            xpc_release(retained_message);
            xpc_release(retained_connection);
            dispatch_async(dispatch_get_main_queue(), ^{
                if (mob_active_connection != NULL) {
                    xpc_release(mob_active_connection);
                    mob_active_connection = NULL;
                }
                mob_operation_active = false;
                atomic_store_explicit(
                    &mob_operation_cancelled,
                    false,
                    memory_order_relaxed);
            });
        });
    });
    xpc_connection_resume(connection);
}

int main(int argc, char **argv) {
    if (!mob_parse_service_config(argc, argv) || !mob_service_account_is_exact() ||
        !mob_native_install_signal_handlers() ||
        !mob_native_service_integrity_ready()) {
        return 70;
    }
    mob_native_reset_interrupt();
    atomic_init(&mob_operation_cancelled, false);
    mob_operation_queue = dispatch_queue_create(
        "com.network-service-platform.monitor-opaque-operation-broker.operation.v1",
        DISPATCH_QUEUE_SERIAL);
    if (mob_operation_queue == NULL) {
        return 70;
    }
    xpc_main(mob_handle_connection);
    return 70;
}
