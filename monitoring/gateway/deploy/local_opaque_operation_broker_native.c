#define _DARWIN_C_SOURCE 1

#include "local_opaque_operation_broker_core.h"
#include "local_opaque_operation_broker_ipc.h"
#include "local_opaque_operation_broker_native.h"

#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecCode.h>
#include <Security/SecKey.h>
#include <Security/SecStaticCode.h>
#include <Security/Security.h>
#include <mach-o/dyld.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <limits.h>
#include <math.h>

#define MOB_RUNTIME_DIRECTORY "/usr/local/libexec/network-service-platform"
#define MOB_SSH_PATH "/usr/bin/ssh"
#define MOB_KEYCHAIN_SERVICE "com.network-service-platform.monitor-opaque-broker.role-record.v1"
#define MOB_STDOUT_LIMIT 32768U
#define MOB_STDERR_LIMIT 8192U
#define MOB_AGENT_MESSAGE_LIMIT 65536U
#define MOB_AGENT_DATA_LIMIT 32768U
#define MOB_AGENT_REQUEST_LIMIT 16U
#define MOB_TOTAL_TIMEOUT_SECONDS 300.0
#define MOB_VERIFY_TIMEOUT_SECONDS 10.0

#define SSH_AGENT_FAILURE 5U
#define SSH_AGENT_REQUEST_IDENTITIES 11U
#define SSH_AGENT_IDENTITIES_ANSWER 12U
#define SSH_AGENT_SIGN_REQUEST 13U
#define SSH_AGENT_SIGN_RESPONSE 14U

typedef struct {
    char operation_name[64];
    char directory[PATH_MAX];
    char identity_path[PATH_MAX];
    char known_hosts_path[PATH_MAX];
    char agent_path[PATH_MAX];
    int root_fd;
    int directory_fd;
    int agent_listener;
    int agent_connection;
    pid_t child_pid;
    bool child_running;
    bool directory_created;
    mob_cleanup_state cleanup_state;
} mob_runtime;

typedef struct {
    uint8_t stdout_data[MOB_STDOUT_LIMIT];
    size_t stdout_length;
    uint8_t stderr_data[MOB_STDERR_LIMIT];
    size_t stderr_length;
    int wait_status;
    bool timed_out;
    bool interrupted;
    bool launch_failed;
    bool agent_failed;
    bool cleanup_failed;
} mob_child_result;

static bool mob_terminate_child(mob_runtime *runtime);

static volatile sig_atomic_t mob_signal_received = 0;

static void mob_signal_handler(int signal_number) {
    mob_signal_received = signal_number;
}

static void mob_wipe(void *value, size_t length) {
    volatile uint8_t *cursor = (volatile uint8_t *)value;
    while (length > 0U) {
        *cursor++ = 0U;
        --length;
    }
}

static double mob_monotonic_seconds(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) {
        return -1.0;
    }
    return (double)value.tv_sec + ((double)value.tv_nsec / 1000000000.0);
}

static bool mob_cfstring_equals(CFTypeRef value, CFStringRef expected) {
    return value != NULL && CFGetTypeID(value) == CFStringGetTypeID() &&
           CFStringCompare((CFStringRef)value, expected, 0U) == kCFCompareEqualTo;
}

static bool mob_cfboolean_equals(CFTypeRef value, bool expected) {
    return value != NULL && CFGetTypeID(value) == CFBooleanGetTypeID() &&
           CFBooleanGetValue((CFBooleanRef)value) == expected;
}

bool mob_native_connection_euid_allowed(
    uid_t peer_euid,
    uid_t authorized_euid,
    uid_t service_euid
) {
    return peer_euid != 0U && authorized_euid != 0U && service_euid != 0U &&
           peer_euid == authorized_euid && peer_euid != service_euid;
}

bool mob_native_peer_evidence_valid(const mob_native_peer_evidence *evidence) {
    return evidence != NULL && evidence->message_code_created &&
           evidence->dynamic_validity_passed && evidence->exact_path_passed &&
           evidence->secure_path_passed && evidence->identifier_passed &&
           evidence->team_identifier_passed && evidence->cdhash_passed &&
           evidence->designated_requirement_passed &&
           evidence->hardened_runtime_present && evidence->ad_hoc_absent &&
           evidence->get_task_allow_safe;
}

bool mob_native_peer_request_authorized(
    uid_t peer_euid,
    uid_t authorized_euid,
    uid_t service_euid,
    bool schema_valid,
    const mob_native_peer_evidence *evidence
) {
    return schema_valid &&
           mob_native_connection_euid_allowed(peer_euid, authorized_euid, service_euid) &&
           mob_native_peer_evidence_valid(evidence);
}

bool mob_native_request_once(bool *request_seen) {
    if (request_seen == NULL || *request_seen) {
        return false;
    }
    *request_seen = true;
    return true;
}

static size_t mob_native_prune_starts(
    double *starts,
    size_t count,
    size_t capacity,
    double now
) {
    size_t read_index;
    size_t write_index = 0U;
    if (starts == NULL || count > capacity) {
        return capacity;
    }
    for (read_index = 0U; read_index < count; ++read_index) {
        if (starts[read_index] > now - MOB_NATIVE_RATE_WINDOW_SECONDS &&
            starts[read_index] <= now) {
            starts[write_index++] = starts[read_index];
        }
    }
    return write_index;
}

bool mob_native_rate_gate_accept(
    mob_native_rate_state *state,
    bool operation_active,
    double now
) {
    if (state == NULL || operation_active || !isfinite(now) || now < 0.0 ||
        state->per_uid_start_count > MOB_NATIVE_PER_UID_RATE_LIMIT ||
        state->global_start_count > MOB_NATIVE_GLOBAL_RATE_LIMIT) {
        return false;
    }
    state->per_uid_start_count = mob_native_prune_starts(
        state->per_uid_starts,
        state->per_uid_start_count,
        MOB_NATIVE_PER_UID_RATE_LIMIT,
        now);
    state->global_start_count = mob_native_prune_starts(
        state->global_starts,
        state->global_start_count,
        MOB_NATIVE_GLOBAL_RATE_LIMIT,
        now);
    if (state->per_uid_start_count >= MOB_NATIVE_PER_UID_RATE_LIMIT ||
        state->global_start_count >= MOB_NATIVE_GLOBAL_RATE_LIMIT) {
        return false;
    }
    state->per_uid_starts[state->per_uid_start_count++] = now;
    state->global_starts[state->global_start_count++] = now;
    return true;
}

bool mob_native_key_capabilities_exact(CFDictionaryRef attributes) {
    return attributes != NULL && CFGetTypeID(attributes) == CFDictionaryGetTypeID() &&
           mob_cfboolean_equals(CFDictionaryGetValue(attributes, kSecAttrIsPermanent), true) &&
           mob_cfboolean_equals(CFDictionaryGetValue(attributes, kSecAttrIsExtractable), false) &&
           mob_cfboolean_equals(CFDictionaryGetValue(attributes, kSecAttrCanSign), true) &&
           mob_cfboolean_equals(CFDictionaryGetValue(attributes, kSecAttrCanDecrypt), false) &&
           mob_cfboolean_equals(CFDictionaryGetValue(attributes, kSecAttrCanDerive), false) &&
           mob_cfboolean_equals(CFDictionaryGetValue(attributes, kSecAttrCanEncrypt), false) &&
           mob_cfboolean_equals(CFDictionaryGetValue(attributes, kSecAttrCanUnwrap), false) &&
           mob_cfboolean_equals(CFDictionaryGetValue(attributes, kSecAttrCanWrap), false) &&
           mob_cfboolean_equals(CFDictionaryGetValue(attributes, kSecAttrCanVerify), false);
}

__attribute__((weak)) const char *mob_native_platform_child_path(void) {
    return MOB_SSH_PATH;
}

__attribute__((weak)) const char *mob_native_platform_runtime_root(void) {
    return MOB_SERVICE_RUNTIME_ROOT;
}

__attribute__((weak)) double mob_native_platform_timeout_seconds(bool verify_only) {
    return verify_only ? MOB_VERIFY_TIMEOUT_SECONDS : MOB_TOTAL_TIMEOUT_SECONDS;
}

__attribute__((weak)) bool mob_native_platform_cancelled(void) {
    return false;
}

__attribute__((weak)) bool mob_native_platform_sign_der(
    void *signing_key,
    const uint8_t *message,
    size_t message_length,
    uint8_t *signature,
    size_t signature_capacity,
    size_t *signature_length
) {
    CFDataRef input = NULL;
    CFDataRef result = NULL;
    CFErrorRef error = NULL;
    bool valid = false;
    if (signing_key == NULL || message == NULL || message_length == 0U ||
        signature == NULL || signature_length == NULL) {
        return false;
    }
    input = CFDataCreate(kCFAllocatorDefault, message, (CFIndex)message_length);
    if (input == NULL) {
        return false;
    }
    result = SecKeyCreateSignature(
        (SecKeyRef)signing_key,
        kSecKeyAlgorithmECDSASignatureMessageX962SHA256,
        input,
        &error);
    if (result != NULL && CFDataGetLength(result) > 0 &&
        (size_t)CFDataGetLength(result) <= signature_capacity) {
        *signature_length = (size_t)CFDataGetLength(result);
        memcpy(signature, CFDataGetBytePtr(result), *signature_length);
        valid = true;
    }
    if (error != NULL) {
        CFRelease(error);
    }
    if (result != NULL) {
        CFRelease(result);
    }
    CFRelease(input);
    return valid;
}

static bool mob_lstat_regular_root_file(const char *path, mode_t exact_mode, bool require_exact_mode) {
    struct stat metadata;
    if (path == NULL || lstat(path, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        metadata.st_uid != 0U || metadata.st_gid != 0U ||
        (metadata.st_mode & (S_IWGRP | S_IWOTH)) != 0U) {
        return false;
    }
    if (require_exact_mode && (metadata.st_mode & 07777U) != exact_mode) {
        return false;
    }
    return true;
}

static bool mob_lstat_root_directory(const char *path, mode_t exact_mode) {
    struct stat metadata;
    return path != NULL && lstat(path, &metadata) == 0 && S_ISDIR(metadata.st_mode) &&
           metadata.st_uid == 0U && metadata.st_gid == 0U &&
           (metadata.st_mode & 07777U) == exact_mode;
}

static bool mob_fd_extended_acl_is_absent(int descriptor) {
    struct stat before;
    struct stat after;
    acl_t acl;
    int acl_errno;
    if (descriptor < 0 || fstat(descriptor, &before) != 0) {
        return false;
    }
    errno = 0;
    acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED);
    acl_errno = errno;
    if (acl != NULL) {
        acl_free(acl);
        return false;
    }
    if (acl_errno != ENOENT || fstat(descriptor, &after) != 0) {
        return false;
    }
    return before.st_dev == after.st_dev && before.st_ino == after.st_ino &&
           before.st_mode == after.st_mode && before.st_uid == after.st_uid &&
           before.st_gid == after.st_gid;
}

static bool mob_service_runtime_root_is_exact(void) {
    struct stat path_metadata;
    struct stat descriptor_metadata;
    int descriptor;
    bool valid;
    if (lstat(MOB_SERVICE_RUNTIME_ROOT, &path_metadata) != 0 ||
        !S_ISDIR(path_metadata.st_mode) || path_metadata.st_uid != geteuid() ||
        path_metadata.st_gid != getegid() ||
        (path_metadata.st_mode & 07777U) != 0700U) {
        return false;
    }
    descriptor = open(
        MOB_SERVICE_RUNTIME_ROOT,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) {
        return false;
    }
    valid = fstat(descriptor, &descriptor_metadata) == 0 &&
        descriptor_metadata.st_dev == path_metadata.st_dev &&
        descriptor_metadata.st_ino == path_metadata.st_ino &&
        mob_fd_extended_acl_is_absent(descriptor);
    return close(descriptor) == 0 && valid;
}

static bool mob_validate_root_ancestors(const char *path) {
    char copy[PATH_MAX];
    char *separator;
    if (path == NULL || strlen(path) >= sizeof(copy) || path[0] != '/') {
        return false;
    }
    memcpy(copy, path, strlen(path) + 1U);
    separator = copy + 1;
    while ((separator = strchr(separator, '/')) != NULL) {
        struct stat metadata;
        *separator = '\0';
        if (lstat(copy, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_uid != 0U ||
            (metadata.st_mode & (S_IWGRP | S_IWOTH)) != 0U) {
            return false;
        }
        *separator = '/';
        ++separator;
    }
    return true;
}

static bool mob_check_static_code(const char *path, CFStringRef requirement_text) {
    CFURLRef url = NULL;
    SecStaticCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    CFDictionaryRef signing = NULL;
    OSStatus status;
    bool valid = false;
    url = CFURLCreateFromFileSystemRepresentation(
        kCFAllocatorDefault,
        (const UInt8 *)path,
        (CFIndex)strlen(path),
        false
    );
    if (url == NULL) {
        goto done;
    }
    status = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
    if (status != errSecSuccess || code == NULL) {
        goto done;
    }
    status = SecRequirementCreateWithString(requirement_text, kSecCSDefaultFlags, &requirement);
    if (status != errSecSuccess || requirement == NULL) {
        goto done;
    }
    status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, requirement);
    if (status == errSecSuccess &&
        SecCodeCopySigningInformation(code, kSecCSSigningInformation, &signing) == errSecSuccess &&
        signing != NULL && CFDictionaryGetValue(signing, kSecCodeInfoPlatformIdentifier) != NULL) {
        valid = true;
    }
done:
    if (signing != NULL) {
        CFRelease(signing);
    }
    if (requirement != NULL) {
        CFRelease(requirement);
    }
    if (code != NULL) {
        CFRelease(code);
    }
    if (url != NULL) {
        CFRelease(url);
    }
    return valid;
}

static bool mob_check_self_signature(void) {
    SecCodeRef self = NULL;
    SecRequirementRef designated = NULL;
    CFDictionaryRef signing = NULL;
    CFTypeRef flags_value;
    CFTypeRef identifier;
    CFTypeRef entitlements;
    CFTypeRef get_task_allow;
    uint32_t flags = 0U;
    bool valid = false;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &self) != errSecSuccess || self == NULL ||
        SecCodeCheckValidity(self, kSecCSStrictValidate, NULL) != errSecSuccess ||
        SecCodeCopyDesignatedRequirement(self, kSecCSDefaultFlags, &designated) != errSecSuccess ||
        designated == NULL ||
        SecCodeCopySigningInformation(
            self,
            kSecCSSigningInformation | kSecCSRequirementInformation | kSecCSDynamicInformation,
            &signing
        ) != errSecSuccess || signing == NULL) {
        goto done;
    }
    flags_value = CFDictionaryGetValue(signing, kSecCodeInfoFlags);
    identifier = CFDictionaryGetValue(signing, kSecCodeInfoIdentifier);
    entitlements = CFDictionaryGetValue(signing, kSecCodeInfoEntitlementsDict);
    if (flags_value == NULL || CFGetTypeID(flags_value) != CFNumberGetTypeID() ||
        !CFNumberGetValue((CFNumberRef)flags_value, kCFNumberSInt32Type, &flags) ||
        (flags & kSecCodeSignatureAdhoc) != 0U || (flags & kSecCodeSignatureRuntime) == 0U ||
        identifier == NULL || CFGetTypeID(identifier) != CFStringGetTypeID() ||
        CFStringGetLength((CFStringRef)identifier) == 0 || entitlements == NULL ||
        CFGetTypeID(entitlements) != CFDictionaryGetTypeID() ||
        CFDictionaryGetCount((CFDictionaryRef)entitlements) != 1) {
        goto done;
    }
    get_task_allow = CFDictionaryGetValue((CFDictionaryRef)entitlements, CFSTR("com.apple.security.get-task-allow"));
    if (get_task_allow == NULL || !mob_cfboolean_equals(get_task_allow, false)) {
        goto done;
    }
    valid = true;
done:
    if (signing != NULL) {
        CFRelease(signing);
    }
    if (designated != NULL) {
        CFRelease(designated);
    }
    if (self != NULL) {
        CFRelease(self);
    }
    return valid;
}

static bool mob_validate_integrity(void) {
    char executable[PATH_MAX];
    char resolved[PATH_MAX];
    uint32_t executable_length = (uint32_t)sizeof(executable);
    if (_NSGetExecutablePath(executable, &executable_length) != 0 ||
        realpath(executable, resolved) == NULL || strcmp(resolved, MOB_SERVICE_PATH) != 0 ||
        !mob_lstat_root_directory(MOB_RUNTIME_DIRECTORY, 0755U) ||
        !mob_lstat_regular_root_file(MOB_SERVICE_PATH, 0555U, true) ||
        !mob_validate_root_ancestors(MOB_SERVICE_PATH) || !mob_check_self_signature() ||
        !mob_service_runtime_root_is_exact() ||
        !mob_lstat_regular_root_file(MOB_SSH_PATH, 0U, false) ||
        !mob_validate_root_ancestors(MOB_SSH_PATH) ||
        !mob_check_static_code(MOB_SSH_PATH, CFSTR("anchor apple"))) {
        return false;
    }
    return true;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static bool mob_trusted_application_matches(SecTrustedApplicationRef application, const char *path) {
    SecTrustedApplicationRef expected = NULL;
    CFDataRef actual_data = NULL;
    CFDataRef expected_data = NULL;
    bool matches = false;
    if (application == NULL || CFGetTypeID(application) != SecTrustedApplicationGetTypeID() ||
        path == NULL || SecTrustedApplicationCreateFromPath(path, &expected) != errSecSuccess ||
        expected == NULL || SecTrustedApplicationCopyData(application, &actual_data) != errSecSuccess ||
        actual_data == NULL || SecTrustedApplicationCopyData(expected, &expected_data) != errSecSuccess ||
        expected_data == NULL) {
        goto done;
    }
    matches = CFEqual(actual_data, expected_data);
done:
    if (expected_data != NULL) {
        CFRelease(expected_data);
    }
    if (actual_data != NULL) {
        CFRelease(actual_data);
    }
    if (expected != NULL) {
        CFRelease(expected);
    }
    return matches;
}

static bool mob_trusted_application_list_is_exact(CFArrayRef applications) {
    bool broker_seen = false;
    bool admin_seen = false;
    CFIndex index;
    if (applications == NULL || CFGetTypeID(applications) != CFArrayGetTypeID() ||
        CFArrayGetCount(applications) != 2) {
        return false;
    }
    for (index = 0; index < CFArrayGetCount(applications); ++index) {
        SecTrustedApplicationRef application =
            (SecTrustedApplicationRef)CFArrayGetValueAtIndex(applications, index);
        if (!broker_seen && mob_trusted_application_matches(application, MOB_SERVICE_PATH)) {
            broker_seen = true;
        } else if (!admin_seen && mob_trusted_application_matches(application, MOB_ADMIN_PATH)) {
            admin_seen = true;
        } else {
            return false;
        }
    }
    return broker_seen && admin_seen;
}

static bool mob_access_is_exact(CFTypeRef value, CFTypeRef authorization) {
    CFArrayRef acl_list = NULL;
    bool valid = false;
    CFIndex index;
    if (value == NULL || CFGetTypeID(value) != SecAccessGetTypeID() || authorization == NULL) {
        goto done;
    }
    acl_list = SecAccessCopyMatchingACLList((SecAccessRef)value, authorization);
    if (acl_list == NULL || CFArrayGetCount(acl_list) != 1) {
        goto done;
    }
    for (index = 0; index < CFArrayGetCount(acl_list); ++index) {
        SecACLRef acl = (SecACLRef)CFArrayGetValueAtIndex(acl_list, index);
        CFArrayRef applications = NULL;
        CFStringRef description = NULL;
        SecKeychainPromptSelector prompt_selector;
        bool acl_valid;
        memset(&prompt_selector, 0, sizeof(prompt_selector));
        if (acl == NULL || CFGetTypeID(acl) != SecACLGetTypeID() ||
            SecACLCopyContents(acl, &applications, &description, &prompt_selector) != errSecSuccess) {
            if (applications != NULL) {
                CFRelease(applications);
            }
            if (description != NULL) {
                CFRelease(description);
            }
            goto done;
        }
        acl_valid = mob_trusted_application_list_is_exact(applications);
        if (applications != NULL) {
            CFRelease(applications);
        }
        if (description != NULL) {
            CFRelease(description);
        }
        if (!acl_valid) {
            goto done;
        }
    }
    valid = true;
done:
    if (acl_list != NULL) {
        CFRelease(acl_list);
    }
    return valid;
}
#pragma clang diagnostic pop

static mob_protected_access_outcome mob_map_keychain_status(OSStatus status) {
    if (status == errSecItemNotFound) {
        return MOB_PROTECTED_ACCESS_NOT_FOUND;
    }
    if (status == errSecInteractionNotAllowed) {
        return MOB_PROTECTED_ACCESS_INTERACTION_REQUIRED;
    }
    if (status == errSecAuthFailed || status == errSecUserCanceled || status == errSecNotAvailable) {
        return MOB_PROTECTED_ACCESS_DENIED;
    }
    return MOB_PROTECTED_ACCESS_DENIED;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static const char *mob_copy_role_record(CFDataRef *record_data) {
    const void *keys[] = {
        kSecClass,
        kSecAttrService,
        kSecAttrAccount,
        kSecAttrSynchronizable,
        kSecMatchSearchList,
        kSecMatchLimit,
        kSecReturnData,
        kSecReturnAttributes,
        kSecUseAuthenticationUI
    };
    const void *values[sizeof(keys) / sizeof(keys[0])];
    const void *search_values[1];
    SecKeychainRef keychain = NULL;
    CFArrayRef search_list = NULL;
    CFDictionaryRef query = NULL;
    CFTypeRef result = NULL;
    OSStatus status;
    const char *reason;
    if (record_data == NULL) {
        return "INTERNAL_FAIL_CLOSED";
    }
    *record_data = NULL;
    if (SecKeychainOpen(MOB_SYSTEM_KEYCHAIN_PATH, &keychain) != errSecSuccess ||
        keychain == NULL) {
        return "PROTECTED_RECORD_ACCESS_DENIED";
    }
    search_values[0] = keychain;
    search_list = CFArrayCreate(
        kCFAllocatorDefault,
        search_values,
        1,
        &kCFTypeArrayCallBacks);
    if (search_list == NULL) {
        CFRelease(keychain);
        return "INTERNAL_FAIL_CLOSED";
    }
    values[0] = kSecClassGenericPassword;
    values[1] = CFSTR(MOB_KEYCHAIN_SERVICE);
    values[2] = CFSTR(MOB_ROLE);
    values[3] = kCFBooleanFalse;
    values[4] = search_list;
    values[5] = kSecMatchLimitAll;
    values[6] = kCFBooleanTrue;
    values[7] = kCFBooleanTrue;
    values[8] = kSecUseAuthenticationUIFail;
    query = CFDictionaryCreate(
        kCFAllocatorDefault,
        keys,
        values,
        (CFIndex)(sizeof(keys) / sizeof(keys[0])),
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    if (query == NULL) {
        reason = "INTERNAL_FAIL_CLOSED";
        goto done;
    }
    status = SecItemCopyMatching(query, &result);
    CFRelease(query);
    query = NULL;
    if (status != errSecSuccess) {
        reason = mob_protected_access_reason(false, mob_map_keychain_status(status), 0U);
        goto done;
    }
    if (result == NULL || CFGetTypeID(result) != CFArrayGetTypeID()) {
        reason = "PROTECTED_RECORD_INVALID";
        goto done;
    }
    reason = mob_protected_access_reason(
        false,
        MOB_PROTECTED_ACCESS_SUCCESS,
        (size_t)CFArrayGetCount((CFArrayRef)result)
    );
    if (strcmp(reason, "SUCCESS") != 0) {
        goto done;
    }
    CFTypeRef item = CFArrayGetValueAtIndex((CFArrayRef)result, 0);
    if (item == NULL || CFGetTypeID(item) != CFDictionaryGetTypeID()) {
        reason = "PROTECTED_RECORD_INVALID";
        goto done;
    }
    CFTypeRef value_data = CFDictionaryGetValue((CFDictionaryRef)item, kSecValueData);
    CFTypeRef access = CFDictionaryGetValue((CFDictionaryRef)item, kSecAttrAccess);
    if (value_data == NULL || CFGetTypeID(value_data) != CFDataGetTypeID() ||
        !mob_access_is_exact(access, kSecACLAuthorizationDecrypt)) {
        reason = "PROTECTED_RECORD_ACCESS_DENIED";
        goto done;
    }
    *record_data = (CFDataRef)CFRetain(value_data);
    reason = "SUCCESS";
done:
    if (query != NULL) {
        CFRelease(query);
    }
    if (result != NULL) {
        CFRelease(result);
    }
    if (search_list != NULL) {
        CFRelease(search_list);
    }
    if (keychain != NULL) {
        CFRelease(keychain);
    }
    return reason;
}
#pragma clang diagnostic pop

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static const char *mob_copy_identity(
    const mob_role_record *record,
    SecKeyRef *private_key,
    uint8_t *public_blob,
    size_t public_blob_capacity,
    size_t *public_blob_length
) {
    CFDataRef persistent_ref = NULL;
    SecKeychainRef keychain = NULL;
    CFArrayRef search_list = NULL;
    CFDictionaryRef query = NULL;
    CFTypeRef result = NULL;
    CFDictionaryRef attributes = NULL;
    SecKeyRef resolved_key = NULL;
    SecKeyRef public_key = NULL;
    CFDataRef external = NULL;
    CFErrorRef error = NULL;
    uint8_t digest[32];
    const void *keys[] = {
        kSecClass,
        kSecValuePersistentRef,
        kSecMatchSearchList,
        kSecMatchLimit,
        kSecReturnRef,
        kSecReturnAttributes,
        kSecUseAuthenticationUI
    };
    const void *values[sizeof(keys) / sizeof(keys[0])];
    const void *search_values[1];
    OSStatus status;
    const char *reason;
    if (record == NULL || private_key == NULL || public_blob == NULL || public_blob_length == NULL) {
        return "INTERNAL_FAIL_CLOSED";
    }
    *private_key = NULL;
    persistent_ref = CFDataCreate(
        kCFAllocatorDefault,
        record->persistent_key_ref,
        (CFIndex)record->persistent_key_ref_length
    );
    if (persistent_ref == NULL) {
        return "INTERNAL_FAIL_CLOSED";
    }
    if (SecKeychainOpen(MOB_SYSTEM_KEYCHAIN_PATH, &keychain) != errSecSuccess ||
        keychain == NULL) {
        reason = "IDENTITY_KEY_ACCESS_DENIED";
        goto done;
    }
    search_values[0] = keychain;
    search_list = CFArrayCreate(
        kCFAllocatorDefault,
        search_values,
        1,
        &kCFTypeArrayCallBacks);
    if (search_list == NULL) {
        reason = "INTERNAL_FAIL_CLOSED";
        goto done;
    }
    values[0] = kSecClassKey;
    values[1] = persistent_ref;
    values[2] = search_list;
    values[3] = kSecMatchLimitOne;
    values[4] = kCFBooleanTrue;
    values[5] = kCFBooleanTrue;
    values[6] = kSecUseAuthenticationUIFail;
    query = CFDictionaryCreate(
        kCFAllocatorDefault,
        keys,
        values,
        (CFIndex)(sizeof(keys) / sizeof(keys[0])),
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    if (query == NULL) {
        reason = "INTERNAL_FAIL_CLOSED";
        goto done;
    }
    status = SecItemCopyMatching(query, &result);
    if (status != errSecSuccess) {
        reason = mob_protected_access_reason(true, mob_map_keychain_status(status), 0U);
        goto done;
    }
    if (result == NULL || CFGetTypeID(result) != CFDictionaryGetTypeID()) {
        reason = "IDENTITY_BINDING_REJECTED";
        goto done;
    }
    CFTypeRef key_value = CFDictionaryGetValue((CFDictionaryRef)result, kSecValueRef);
    CFTypeRef access = CFDictionaryGetValue((CFDictionaryRef)result, kSecAttrAccess);
    if (key_value == NULL || CFGetTypeID(key_value) != SecKeyGetTypeID() ||
        !mob_access_is_exact(access, kSecACLAuthorizationSign)) {
        reason = "IDENTITY_BINDING_REJECTED";
        goto done;
    }
    resolved_key = (SecKeyRef)key_value;
    attributes = SecKeyCopyAttributes(resolved_key);
    if (attributes == NULL ||
        !mob_cfstring_equals(CFDictionaryGetValue(attributes, kSecAttrKeyType), kSecAttrKeyTypeECSECPrimeRandom) ||
        !mob_cfstring_equals(CFDictionaryGetValue(attributes, kSecAttrKeyClass), kSecAttrKeyClassPrivate) ||
        !mob_native_key_capabilities_exact(attributes)) {
        reason = "IDENTITY_BINDING_REJECTED";
        goto done;
    }
    public_key = SecKeyCopyPublicKey(resolved_key);
    if (public_key == NULL) {
        reason = "IDENTITY_BINDING_REJECTED";
        goto done;
    }
    external = SecKeyCopyExternalRepresentation(public_key, &error);
    if (external == NULL || CFDataGetLength(external) != 65 ||
        !mob_make_p256_key_blob(
            CFDataGetBytePtr(external),
            (size_t)CFDataGetLength(external),
            public_blob,
            public_blob_capacity,
            public_blob_length
        )) {
        reason = "IDENTITY_BINDING_REJECTED";
        goto done;
    }
    mob_sha256(public_blob, *public_blob_length, digest);
    if (memcmp(digest, record->identity_sha256, sizeof(digest)) != 0 ||
        !SecKeyIsAlgorithmSupported(resolved_key, kSecKeyOperationTypeSign, kSecKeyAlgorithmECDSASignatureMessageX962SHA256)) {
        reason = "IDENTITY_BINDING_REJECTED";
        goto done;
    }
    *private_key = (SecKeyRef)CFRetain(resolved_key);
    reason = "SUCCESS";
done:
    mob_wipe(digest, sizeof(digest));
    if (error != NULL) {
        CFRelease(error);
    }
    if (external != NULL) {
        CFRelease(external);
    }
    if (public_key != NULL) {
        CFRelease(public_key);
    }
    if (attributes != NULL) {
        CFRelease(attributes);
    }
    if (result != NULL) {
        CFRelease(result);
    }
    if (query != NULL) {
        CFRelease(query);
    }
    if (persistent_ref != NULL) {
        CFRelease(persistent_ref);
    }
    if (search_list != NULL) {
        CFRelease(search_list);
    }
    if (keychain != NULL) {
        CFRelease(keychain);
    }
    return reason;
}
#pragma clang diagnostic pop

static bool mob_write_file_exclusive(
    int directory_fd,
    const char *name,
    const uint8_t *data,
    size_t length
) {
    int descriptor;
    struct stat descriptor_metadata;
    struct stat path_metadata;
    size_t offset = 0U;
    if (directory_fd < 0 || name == NULL || strchr(name, '/') != NULL || data == NULL) {
        return false;
    }
    descriptor = openat(
        directory_fd,
        name,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        0600);
    if (descriptor < 0) {
        return false;
    }
    while (offset < length) {
        const ssize_t written = write(descriptor, data + offset, length - offset);
        if (written <= 0) {
            close(descriptor);
            return false;
        }
        offset += (size_t)written;
    }
    const bool valid = fchmod(descriptor, 0600) == 0 &&
        fstat(descriptor, &descriptor_metadata) == 0 &&
        fstatat(directory_fd, name, &path_metadata, AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISREG(descriptor_metadata.st_mode) &&
        descriptor_metadata.st_uid == geteuid() && descriptor_metadata.st_gid == getegid() &&
        (descriptor_metadata.st_mode & 07777U) == 0600U && descriptor_metadata.st_nlink == 1 &&
        descriptor_metadata.st_dev == path_metadata.st_dev &&
        descriptor_metadata.st_ino == path_metadata.st_ino && fsync(descriptor) == 0;
    return close(descriptor) == 0 && valid;
}

static bool mob_runtime_prepare(
    mob_runtime *runtime,
    const mob_role_record *record,
    const uint8_t *identity_blob,
    size_t identity_blob_length,
    uid_t caller_uid
) {
    uint8_t host_blob[64];
    size_t host_blob_length = 0U;
    char host_base64[128];
    size_t host_base64_length = 0U;
    char identity_base64[512];
    size_t identity_base64_length = 0U;
    char known_hosts[256];
    char identity[640];
    const char *root_path;
    struct stat root_metadata;
    struct stat root_descriptor_metadata;
    struct stat directory_metadata;
    struct stat directory_path_metadata;
    struct stat socket_metadata;
    int written;
    unsigned int attempt;
    struct sockaddr_un address;
    if (runtime == NULL || record == NULL || identity_blob == NULL ||
        identity_blob_length == 0U || identity_blob_length > 256U || caller_uid == 0U) {
        return false;
    }
    memset(runtime, 0, sizeof(*runtime));
    runtime->root_fd = -1;
    runtime->directory_fd = -1;
    runtime->agent_listener = -1;
    runtime->agent_connection = -1;
    runtime->child_pid = -1;
    runtime->cleanup_state = MOB_CLEANUP_INIT;
    root_path = mob_native_platform_runtime_root();
    if (root_path == NULL || !mob_validate_internal_path(root_path) ||
        !mob_native_connection_euid_allowed(caller_uid, caller_uid, geteuid()) ||
        lstat(root_path, &root_metadata) != 0 || !S_ISDIR(root_metadata.st_mode) ||
        root_metadata.st_uid != geteuid() || root_metadata.st_gid != getegid() ||
        (root_metadata.st_mode & 07777U) != 0700U) {
        return false;
    }
    runtime->root_fd = open(root_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (runtime->root_fd < 0 || fstat(runtime->root_fd, &root_descriptor_metadata) != 0 ||
        root_descriptor_metadata.st_dev != root_metadata.st_dev ||
        root_descriptor_metadata.st_ino != root_metadata.st_ino ||
        !mob_fd_extended_acl_is_absent(runtime->root_fd)) {
        return false;
    }
    for (attempt = 0U; attempt < 32U; ++attempt) {
        uint32_t random_value;
        arc4random_buf(&random_value, sizeof(random_value));
        written = snprintf(
            runtime->operation_name,
            sizeof(runtime->operation_name),
            "o%08x",
            random_value);
        if (written <= 0 || (size_t)written >= sizeof(runtime->operation_name)) {
            return false;
        }
        if (mkdirat(runtime->root_fd, runtime->operation_name, 0700) == 0) {
            runtime->directory_created = true;
            break;
        }
        if (errno != EEXIST) {
            return false;
        }
    }
    if (attempt == 32U) {
        return false;
    }
    runtime->directory_fd = openat(
        runtime->root_fd,
        runtime->operation_name,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (runtime->directory_fd < 0 || fchmod(runtime->directory_fd, 0700) != 0 ||
        fstat(runtime->directory_fd, &directory_metadata) != 0 ||
        fstatat(
            runtime->root_fd,
            runtime->operation_name,
            &directory_path_metadata,
            AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISDIR(directory_metadata.st_mode) || directory_metadata.st_uid != geteuid() ||
        directory_metadata.st_gid != getegid() ||
        (directory_metadata.st_mode & 07777U) != 0700U ||
        directory_metadata.st_dev != directory_path_metadata.st_dev ||
        directory_metadata.st_ino != directory_path_metadata.st_ino ||
        !mob_fd_extended_acl_is_absent(runtime->directory_fd)) {
        return false;
    }
    written = snprintf(
        runtime->directory,
        sizeof(runtime->directory),
        "%s/%s",
        root_path,
        runtime->operation_name);
    if (written <= 0 || (size_t)written >= sizeof(runtime->directory) ||
        !mob_validate_internal_path(runtime->directory)) {
        return false;
    }
    written = snprintf(
        runtime->identity_path,
        sizeof(runtime->identity_path),
        "%s/identity.pub",
        runtime->directory);
    if (written <= 0 || (size_t)written >= sizeof(runtime->identity_path)) {
        return false;
    }
    written = snprintf(
        runtime->known_hosts_path,
        sizeof(runtime->known_hosts_path),
        "%s/known_hosts",
        runtime->directory);
    if (written <= 0 || (size_t)written >= sizeof(runtime->known_hosts_path)) {
        return false;
    }
    written = snprintf(
        runtime->agent_path,
        sizeof(runtime->agent_path),
        "%s/agent.sock",
        runtime->directory);
    if (written <= 0 || (size_t)written >= sizeof(runtime->agent_path) ||
        !mob_validate_internal_path(runtime->identity_path) ||
        !mob_validate_internal_path(runtime->known_hosts_path) ||
        !mob_validate_internal_path(runtime->agent_path)) {
        return false;
    }
    if (!mob_make_ed25519_key_blob(record->host_key, host_blob, sizeof(host_blob), &host_blob_length) ||
        !mob_base64_encode(host_blob, host_blob_length, host_base64, sizeof(host_base64), &host_base64_length) ||
        !mob_base64_encode(identity_blob, identity_blob_length, identity_base64, sizeof(identity_base64), &identity_base64_length)) {
        return false;
    }
    written = snprintf(
        known_hosts,
        sizeof(known_hosts),
        "%s %s %s\n",
        MOB_HOST_KEY_ALIAS,
        MOB_HOST_KEY_ALGORITHM,
        host_base64
    );
    if (written <= 0 || (size_t)written >= sizeof(known_hosts) ||
        !mob_write_file_exclusive(
            runtime->directory_fd,
            "known_hosts",
            (const uint8_t *)known_hosts,
            (size_t)written)) {
        return false;
    }
    written = snprintf(
        identity,
        sizeof(identity),
        "%s %s monitor-opaque-operation-broker-v1\n",
        MOB_IDENTITY_ALGORITHM,
        identity_base64
    );
    if (written <= 0 || (size_t)written >= sizeof(identity) ||
        !mob_write_file_exclusive(
            runtime->directory_fd,
            "identity.pub",
            (const uint8_t *)identity,
            (size_t)written)) {
        return false;
    }
    runtime->agent_listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (runtime->agent_listener < 0 || fcntl(runtime->agent_listener, F_SETFD, FD_CLOEXEC) != 0) {
        return false;
    }
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    if (strlen(runtime->agent_path) >= sizeof(address.sun_path)) {
        return false;
    }
    memcpy(address.sun_path, runtime->agent_path, strlen(runtime->agent_path) + 1U);
    if (bind(runtime->agent_listener, (const struct sockaddr *)&address, sizeof(address)) != 0 ||
        chmod(runtime->agent_path, 0600) != 0 ||
        fstatat(runtime->directory_fd, "agent.sock", &socket_metadata, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISSOCK(socket_metadata.st_mode) || socket_metadata.st_uid != geteuid() ||
        socket_metadata.st_gid != getegid() || (socket_metadata.st_mode & 07777U) != 0600U ||
        listen(runtime->agent_listener, 1) != 0) {
        return false;
    }
    return mob_cleanup_transition(&runtime->cleanup_state, MOB_CLEANUP_RESOURCES_READY);
}

static bool mob_runtime_cleanup(mob_runtime *runtime) {
    bool clean = true;
    if (runtime == NULL) {
        return false;
    }
    if (runtime->cleanup_state != MOB_CLEANUP_CLEANING &&
        !mob_cleanup_transition(&runtime->cleanup_state, MOB_CLEANUP_CLEANING)) {
        clean = false;
    }
    if (runtime->child_pid > 0 && !mob_terminate_child(runtime)) {
        clean = false;
    }
    if (runtime->agent_connection >= 0 && close(runtime->agent_connection) != 0) {
        clean = false;
    }
    runtime->agent_connection = -1;
    if (runtime->agent_listener >= 0 && close(runtime->agent_listener) != 0) {
        clean = false;
    }
    runtime->agent_listener = -1;
    if (runtime->directory_fd >= 0 &&
        unlinkat(runtime->directory_fd, "agent.sock", 0) != 0 && errno != ENOENT) {
        clean = false;
    }
    if (runtime->directory_fd >= 0 &&
        unlinkat(runtime->directory_fd, "identity.pub", 0) != 0 && errno != ENOENT) {
        clean = false;
    }
    if (runtime->directory_fd >= 0 &&
        unlinkat(runtime->directory_fd, "known_hosts", 0) != 0 && errno != ENOENT) {
        clean = false;
    }
    if (runtime->directory_fd >= 0 && close(runtime->directory_fd) != 0) {
        clean = false;
    }
    runtime->directory_fd = -1;
    if (runtime->root_fd >= 0 && runtime->directory_created &&
        runtime->operation_name[0] != '\0' &&
        unlinkat(runtime->root_fd, runtime->operation_name, AT_REMOVEDIR) != 0 &&
        errno != ENOENT) {
        clean = false;
    }
    if (runtime->root_fd >= 0 && close(runtime->root_fd) != 0) {
        clean = false;
    }
    runtime->root_fd = -1;
    if (runtime->cleanup_state == MOB_CLEANUP_CLEANING) {
        (void)mob_cleanup_transition(
            &runtime->cleanup_state,
            clean ? MOB_CLEANUP_DONE : MOB_CLEANUP_FAILED
        );
    }
    mob_wipe(runtime, sizeof(*runtime));
    return clean;
}

static uint32_t mob_agent_read_u32(const uint8_t value[4]) {
    return ((uint32_t)value[0] << 24U) |
           ((uint32_t)value[1] << 16U) |
           ((uint32_t)value[2] << 8U) |
           (uint32_t)value[3];
}

static void mob_agent_write_u32(uint8_t output[4], uint32_t value) {
    output[0] = (uint8_t)(value >> 24U);
    output[1] = (uint8_t)(value >> 16U);
    output[2] = (uint8_t)(value >> 8U);
    output[3] = (uint8_t)value;
}

static bool mob_poll_deadline(int descriptor, short events, double deadline) {
    struct pollfd item;
    for (;;) {
        const double remaining = deadline - mob_monotonic_seconds();
        int timeout;
        int result;
        if (remaining <= 0.0 || mob_signal_received != 0 ||
            mob_native_platform_cancelled()) {
            return false;
        }
        timeout = remaining > 1.0 ? 1000 : (int)(remaining * 1000.0);
        if (timeout < 1) {
            timeout = 1;
        }
        item.fd = descriptor;
        item.events = events;
        item.revents = 0;
        result = poll(&item, 1U, timeout);
        if (result > 0) {
            return (item.revents & events) != 0;
        }
        if (result < 0 && errno != EINTR) {
            return false;
        }
    }
}

static bool mob_socket_read_exact(int descriptor, uint8_t *output, size_t length, double deadline) {
    size_t offset = 0U;
    while (offset < length) {
        ssize_t received;
        if (!mob_poll_deadline(descriptor, POLLIN, deadline)) {
            return false;
        }
        received = recv(descriptor, output + offset, length - offset, 0);
        if (received <= 0) {
            if (received < 0 && errno == EINTR) {
                continue;
            }
            return false;
        }
        offset += (size_t)received;
    }
    return true;
}

static bool mob_socket_write_exact(int descriptor, const uint8_t *input, size_t length, double deadline) {
    size_t offset = 0U;
    while (offset < length) {
        ssize_t written;
        if (!mob_poll_deadline(descriptor, POLLOUT, deadline)) {
            return false;
        }
        written = send(descriptor, input + offset, length - offset, 0);
        if (written <= 0) {
            if (written < 0 && errno == EINTR) {
                continue;
            }
            return false;
        }
        offset += (size_t)written;
    }
    return true;
}

static bool mob_agent_append(
    uint8_t *output,
    size_t capacity,
    size_t *offset,
    const uint8_t *value,
    size_t length
) {
    if (output == NULL || offset == NULL || value == NULL || length > UINT32_MAX ||
        *offset > capacity || capacity - *offset < 4U || length > capacity - *offset - 4U) {
        return false;
    }
    mob_agent_write_u32(output + *offset, (uint32_t)length);
    memcpy(output + *offset + 4U, value, length);
    *offset += 4U + length;
    return true;
}

static bool mob_der_take_length(
    const uint8_t *input,
    size_t input_length,
    size_t *offset,
    size_t *value_length
) {
    uint8_t first;
    size_t count;
    size_t parsed = 0U;
    size_t index;
    if (input == NULL || offset == NULL || value_length == NULL || *offset >= input_length) {
        return false;
    }
    first = input[(*offset)++];
    if ((first & 0x80U) == 0U) {
        *value_length = (size_t)first;
        return *value_length <= input_length - *offset;
    }
    count = (size_t)(first & 0x7fU);
    if (count == 0U || count > sizeof(size_t) || count > input_length - *offset) {
        return false;
    }
    for (index = 0U; index < count; ++index) {
        parsed = (parsed << 8U) | (size_t)input[(*offset)++];
    }
    if (parsed > input_length - *offset) {
        return false;
    }
    *value_length = parsed;
    return true;
}

static bool mob_ssh_mpint(
    uint8_t *output,
    size_t capacity,
    size_t *offset,
    const uint8_t *integer,
    size_t integer_length
) {
    uint8_t normalized[34];
    size_t normalized_length;
    while (integer_length > 1U && integer[0] == 0U) {
        ++integer;
        --integer_length;
    }
    if (integer_length == 0U || integer_length > 33U) {
        return false;
    }
    normalized_length = integer_length;
    if ((integer[0] & 0x80U) != 0U) {
        normalized[0] = 0U;
        memcpy(normalized + 1U, integer, integer_length);
        ++normalized_length;
    } else {
        memcpy(normalized, integer, integer_length);
    }
    return mob_agent_append(output, capacity, offset, normalized, normalized_length);
}

static bool mob_der_signature_to_ssh(
    const uint8_t *input,
    size_t input_length,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_length
) {
    size_t offset = 0U;
    size_t sequence_length;
    size_t first_length;
    size_t second_length;
    const uint8_t *first;
    const uint8_t *second;
    if (input == NULL || output == NULL || output_length == NULL ||
        input_length < 8U || input[offset++] != 0x30U ||
        !mob_der_take_length(input, input_length, &offset, &sequence_length) ||
        sequence_length != input_length - offset || offset >= input_length || input[offset++] != 0x02U ||
        !mob_der_take_length(input, input_length, &offset, &first_length) || first_length == 0U ||
        first_length > input_length - offset) {
        return false;
    }
    first = input + offset;
    offset += first_length;
    if (offset >= input_length || input[offset++] != 0x02U ||
        !mob_der_take_length(input, input_length, &offset, &second_length) || second_length == 0U ||
        second_length != input_length - offset) {
        return false;
    }
    second = input + offset;
    offset = 0U;
    if (!mob_ssh_mpint(output, output_capacity, &offset, first, first_length) ||
        !mob_ssh_mpint(output, output_capacity, &offset, second, second_length)) {
        return false;
    }
    *output_length = offset;
    return true;
}

static bool mob_agent_failure(int descriptor, double deadline) {
    uint8_t response[5];
    mob_agent_write_u32(response, 1U);
    response[4] = SSH_AGENT_FAILURE;
    return mob_socket_write_exact(descriptor, response, sizeof(response), deadline);
}

static bool mob_agent_process_request(
    int descriptor,
    const mob_native_identity *identity,
    double deadline,
    bool *signed_request
) {
    uint8_t header[4];
    uint8_t request[MOB_AGENT_MESSAGE_LIMIT];
    uint8_t response[MOB_AGENT_MESSAGE_LIMIT];
    uint32_t request_length;
    size_t response_offset = 5U;
    size_t response_payload_length;
    mob_agent_request parsed_request;
    if (signed_request == NULL) {
        return false;
    }
    *signed_request = false;
    if (!mob_socket_read_exact(descriptor, header, sizeof(header), deadline)) {
        return false;
    }
    request_length = mob_agent_read_u32(header);
    if (request_length == 0U || request_length > sizeof(request) ||
        !mob_socket_read_exact(descriptor, request, (size_t)request_length, deadline)) {
        (void)mob_agent_failure(descriptor, deadline);
        return false;
    }
    if (!mob_parse_agent_request(
            request,
            (size_t)request_length,
            identity->public_blob,
            identity->public_blob_length,
            &parsed_request)) {
        (void)mob_agent_failure(descriptor, deadline);
        return false;
    }
    if (parsed_request.type == MOB_AGENT_REQUEST_IDENTITIES) {
        response[4] = SSH_AGENT_IDENTITIES_ANSWER;
        mob_agent_write_u32(response + response_offset, 1U);
        response_offset += 4U;
        if (!mob_agent_append(
                response,
                sizeof(response),
                &response_offset,
                identity->public_blob,
                identity->public_blob_length) ||
            !mob_agent_append(
                response,
                sizeof(response),
                &response_offset,
                (const uint8_t *)"monitor-opaque-operation-broker-v1",
                strlen("monitor-opaque-operation-broker-v1"))) {
            return false;
        }
    } else if (parsed_request.type == MOB_AGENT_REQUEST_SIGN) {
        uint8_t der_signature[128];
        size_t der_signature_length = 0U;
        uint8_t ssh_signature[96];
        size_t ssh_signature_length = 0U;
        uint8_t signature_blob[160];
        size_t signature_blob_length = 0U;
        bool valid = false;
        if (mob_native_platform_sign_der(
            identity->signing_key,
            parsed_request.sign_data,
            parsed_request.sign_data_length,
            der_signature,
            sizeof(der_signature),
            &der_signature_length) &&
            mob_der_signature_to_ssh(
                der_signature,
                der_signature_length,
                ssh_signature,
                sizeof(ssh_signature),
                &ssh_signature_length) &&
            mob_agent_append(
                signature_blob,
                sizeof(signature_blob),
                &signature_blob_length,
                (const uint8_t *)MOB_IDENTITY_ALGORITHM,
                strlen(MOB_IDENTITY_ALGORITHM)) &&
            mob_agent_append(
                signature_blob,
                sizeof(signature_blob),
                &signature_blob_length,
                ssh_signature,
                ssh_signature_length)) {
            response[4] = SSH_AGENT_SIGN_RESPONSE;
            valid = mob_agent_append(
                response,
                sizeof(response),
                &response_offset,
                signature_blob,
                signature_blob_length
            );
        }
        mob_wipe(der_signature, sizeof(der_signature));
        mob_wipe(ssh_signature, sizeof(ssh_signature));
        mob_wipe(signature_blob, sizeof(signature_blob));
        if (!valid) {
            (void)mob_agent_failure(descriptor, deadline);
            return false;
        }
        *signed_request = true;
    } else {
        (void)mob_agent_failure(descriptor, deadline);
        return false;
    }
    response_payload_length = response_offset - 4U;
    if (response_payload_length > UINT32_MAX) {
        return false;
    }
    mob_agent_write_u32(response, (uint32_t)response_payload_length);
    return mob_socket_write_exact(descriptor, response, response_offset, deadline);
}

static bool mob_agent_accept(mob_runtime *runtime, pid_t expected_pid) {
    pid_t peer_pid = -1;
    socklen_t peer_pid_length = (socklen_t)sizeof(peer_pid);
    int connection;
    if (runtime == NULL || runtime->agent_connection >= 0 || expected_pid <= 0) {
        return false;
    }
    connection = accept(runtime->agent_listener, NULL, NULL);
    if (connection < 0 || fcntl(connection, F_SETFD, FD_CLOEXEC) != 0 ||
        getsockopt(connection, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &peer_pid_length) != 0 ||
        peer_pid_length != sizeof(peer_pid) || peer_pid != expected_pid) {
        if (connection >= 0) {
            close(connection);
        }
        return false;
    }
    runtime->agent_connection = connection;
    return true;
}

static bool mob_set_cloexec(int descriptor) {
    return descriptor >= 0 && fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0;
}

static bool mob_set_nonblocking(int descriptor) {
    const int flags = fcntl(descriptor, F_GETFL, 0);
    return flags >= 0 && fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0;
}

static bool mob_pipe(int descriptors[2]) {
    return pipe(descriptors) == 0 && mob_set_cloexec(descriptors[0]) && mob_set_cloexec(descriptors[1]);
}

static bool mob_write_all(int descriptor, const uint8_t *data, size_t length) {
    size_t offset = 0U;
    while (offset < length) {
        const ssize_t written = write(descriptor, data + offset, length - offset);
        if (written < 0 && errno == EINTR) {
            continue;
        }
        if (written <= 0) {
            return false;
        }
        offset += (size_t)written;
    }
    return true;
}

static bool mob_capture_fd(
    int descriptor,
    uint8_t *output,
    size_t capacity,
    size_t *length,
    bool *open_state
) {
    uint8_t buffer[4096];
    for (;;) {
        const ssize_t received = read(descriptor, buffer, sizeof(buffer));
        if (received > 0) {
            if ((size_t)received > capacity - *length) {
                return false;
            }
            memcpy(output + *length, buffer, (size_t)received);
            *length += (size_t)received;
            continue;
        }
        if (received == 0) {
            *open_state = false;
            return true;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return true;
        }
        return false;
    }
}

static bool mob_process_group_empty(pid_t leader) {
    if (leader <= 0) {
        return true;
    }
    errno = 0;
    return kill(-leader, 0) != 0 && errno == ESRCH;
}

static bool mob_terminate_child(mob_runtime *runtime) {
    int status;
    int attempts;
    if (runtime == NULL || runtime->child_pid <= 0) {
        return runtime != NULL;
    }
    if (runtime->child_running) {
        (void)kill(-runtime->child_pid, SIGTERM);
        for (attempts = 0; attempts < 10; ++attempts) {
            const pid_t waited = waitpid(runtime->child_pid, &status, WNOHANG);
            if (waited == runtime->child_pid || (waited < 0 && errno == ECHILD)) {
                runtime->child_running = false;
                break;
            }
            if (waited < 0 && errno != EINTR) {
                break;
            }
            (void)usleep(10000U);
        }
        if (runtime->child_running) {
            (void)kill(-runtime->child_pid, SIGKILL);
            while (waitpid(runtime->child_pid, &status, 0) < 0 && errno == EINTR) {
            }
            runtime->child_running = false;
        }
    }
    if (!mob_process_group_empty(runtime->child_pid)) {
        (void)kill(-runtime->child_pid, SIGTERM);
        for (attempts = 0; attempts < 10 && !mob_process_group_empty(runtime->child_pid); ++attempts) {
            (void)usleep(10000U);
        }
    }
    if (!mob_process_group_empty(runtime->child_pid)) {
        (void)kill(-runtime->child_pid, SIGKILL);
        for (attempts = 0; attempts < 10 && !mob_process_group_empty(runtime->child_pid); ++attempts) {
            (void)usleep(10000U);
        }
    }
    return mob_process_group_empty(runtime->child_pid);
}

static bool mob_spawn_ssh(
    mob_runtime *runtime,
    const char *config,
    size_t config_length,
    bool verify_only,
    const mob_native_identity *identity,
    mob_child_result *result
) {
    int input_pipe[2] = {-1, -1};
    int output_pipe[2] = {-1, -1};
    int error_pipe[2] = {-1, -1};
    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attributes;
    short spawn_flags = POSIX_SPAWN_SETPGROUP;
    bool actions_ready = false;
    bool attributes_ready = false;
    bool output_open = true;
    bool error_open = true;
    unsigned int agent_connections = 0U;
    unsigned int agent_requests = 0U;
    bool agent_signed = false;
    double deadline;
    const char *child_path = mob_native_platform_child_path();
    char *verify_argv[] = {
        (char *)child_path,
        (char *)"-G",
        (char *)"-F",
        (char *)"/dev/stdin",
        (char *)"broker-fnos-v1",
        NULL
    };
    char *connect_argv[] = {
        (char *)child_path,
        (char *)"-F",
        (char *)"/dev/stdin",
        (char *)"broker-fnos-v1",
        NULL
    };
    char *const empty_environment[] = {NULL};
    if (runtime == NULL || config == NULL || config_length == 0U || result == NULL ||
        child_path == NULL || !mob_validate_internal_path(child_path) ||
        (!verify_only && (identity == NULL || identity->signing_key == NULL))) {
        return false;
    }
    memset(result, 0, sizeof(*result));
    result->launch_failed = true;
    if (!mob_pipe(input_pipe) || !mob_pipe(output_pipe) || !mob_pipe(error_pipe) ||
        posix_spawn_file_actions_init(&actions) != 0) {
        goto fail;
    }
    actions_ready = true;
    if (posix_spawn_file_actions_adddup2(&actions, input_pipe[0], STDIN_FILENO) != 0 ||
        posix_spawn_file_actions_adddup2(&actions, output_pipe[1], STDOUT_FILENO) != 0 ||
        posix_spawn_file_actions_adddup2(&actions, error_pipe[1], STDERR_FILENO) != 0 ||
        posix_spawn_file_actions_addclose(&actions, input_pipe[1]) != 0 ||
        posix_spawn_file_actions_addclose(&actions, output_pipe[0]) != 0 ||
        posix_spawn_file_actions_addclose(&actions, error_pipe[0]) != 0 ||
        posix_spawnattr_init(&attributes) != 0) {
        goto fail;
    }
    attributes_ready = true;
#ifdef POSIX_SPAWN_CLOEXEC_DEFAULT
    spawn_flags = (short)(spawn_flags | POSIX_SPAWN_CLOEXEC_DEFAULT);
#endif
    if (posix_spawnattr_setflags(&attributes, spawn_flags) != 0 ||
        posix_spawnattr_setpgroup(&attributes, 0) != 0 ||
        posix_spawn(
            &runtime->child_pid,
            child_path,
            &actions,
            &attributes,
            verify_only ? verify_argv : connect_argv,
            empty_environment
        ) != 0) {
        runtime->child_pid = -1;
        goto fail;
    }
    runtime->child_running = true;
    result->launch_failed = false;
    if (runtime->cleanup_state == MOB_CLEANUP_RESOURCES_READY &&
        !mob_cleanup_transition(&runtime->cleanup_state, MOB_CLEANUP_CHILD_RUNNING)) {
        goto fail;
    }
    close(input_pipe[0]);
    input_pipe[0] = -1;
    close(output_pipe[1]);
    output_pipe[1] = -1;
    close(error_pipe[1]);
    error_pipe[1] = -1;
    if (!mob_write_all(input_pipe[1], (const uint8_t *)config, config_length) || close(input_pipe[1]) != 0 ||
        !mob_set_nonblocking(output_pipe[0]) || !mob_set_nonblocking(error_pipe[0])) {
        input_pipe[1] = -1;
        goto fail;
    }
    input_pipe[1] = -1;
    deadline = mob_monotonic_seconds() + mob_native_platform_timeout_seconds(verify_only);
    while (runtime->child_running || output_open || error_open) {
        struct pollfd poll_items[4];
        nfds_t item_count = 0U;
        int poll_result;
        int timeout;
        int wait_status;
        const double remaining = deadline - mob_monotonic_seconds();
        if (mob_signal_received != 0 || mob_native_platform_cancelled()) {
            result->interrupted = true;
            goto fail;
        }
        if (remaining <= 0.0) {
            result->timed_out = true;
            goto fail;
        }
        if (output_open) {
            poll_items[item_count++] = (struct pollfd){output_pipe[0], POLLIN | POLLHUP, 0};
        }
        if (error_open) {
            poll_items[item_count++] = (struct pollfd){error_pipe[0], POLLIN | POLLHUP, 0};
        }
        if (!verify_only) {
            poll_items[item_count++] = (struct pollfd){runtime->agent_listener, POLLIN, 0};
            if (runtime->agent_connection >= 0) {
                poll_items[item_count++] = (struct pollfd){runtime->agent_connection, POLLIN | POLLHUP, 0};
            }
        }
        timeout = remaining > 0.1 ? 100 : (int)(remaining * 1000.0);
        if (timeout < 1) {
            timeout = 1;
        }
        poll_result = poll(poll_items, item_count, timeout);
        if (poll_result < 0 && errno != EINTR) {
            goto fail;
        }
        if (poll_result > 0) {
            nfds_t item;
            for (item = 0U; item < item_count; ++item) {
                if (poll_items[item].fd == output_pipe[0] && poll_items[item].revents != 0 &&
                    !mob_capture_fd(output_pipe[0], result->stdout_data, sizeof(result->stdout_data), &result->stdout_length, &output_open)) {
                    goto fail;
                }
                if (poll_items[item].fd == error_pipe[0] && poll_items[item].revents != 0 &&
                    !mob_capture_fd(error_pipe[0], result->stderr_data, sizeof(result->stderr_data), &result->stderr_length, &error_open)) {
                    goto fail;
                }
                if (!verify_only && poll_items[item].fd == runtime->agent_listener && (poll_items[item].revents & POLLIN) != 0) {
                    if (agent_connections != 0U || !mob_agent_accept(runtime, runtime->child_pid)) {
                        result->agent_failed = true;
                        goto fail;
                    }
                    ++agent_connections;
                }
                if (!verify_only && runtime->agent_connection >= 0 &&
                    poll_items[item].fd == runtime->agent_connection && poll_items[item].revents != 0) {
                    const short events = poll_items[item].revents;
                    bool close_connection = false;
                    if ((events & (POLLERR | POLLNVAL)) != 0) {
                        result->agent_failed = true;
                        goto fail;
                    }
                    if ((events & POLLIN) != 0) {
                        uint8_t pending;
                        ssize_t peeked;
                        do {
                            peeked = recv(runtime->agent_connection, &pending, sizeof(pending), MSG_PEEK);
                        } while (peeked < 0 && errno == EINTR);
                        if (peeked > 0) {
                            bool signed_request = false;
                            if (agent_requests == MOB_AGENT_REQUEST_LIMIT ||
                                !mob_agent_process_request(
                                    runtime->agent_connection,
                                    identity,
                                    deadline,
                                    &signed_request)) {
                                result->agent_failed = true;
                                goto fail;
                            }
                            ++agent_requests;
                            agent_signed = agent_signed || signed_request;
                            close_connection = (events & POLLHUP) != 0;
                        } else if (peeked == 0) {
                            close_connection = true;
                        } else if (errno != EAGAIN && errno != EWOULDBLOCK) {
                            result->agent_failed = true;
                            goto fail;
                        }
                    } else if ((events & POLLHUP) != 0) {
                        close_connection = true;
                    }
                    if (close_connection) {
                        if (!agent_signed) {
                            result->agent_failed = true;
                            goto fail;
                        }
                        close(runtime->agent_connection);
                        runtime->agent_connection = -1;
                    }
                }
            }
        }
        if (runtime->child_running) {
            const pid_t waited = waitpid(runtime->child_pid, &wait_status, WNOHANG);
            if (waited == runtime->child_pid) {
                runtime->child_running = false;
                result->wait_status = wait_status;
            } else if (waited < 0 && errno != EINTR) {
                goto fail;
            }
        }
    }
    if (!verify_only && (agent_connections != 1U || agent_requests == 0U ||
        agent_requests > MOB_AGENT_REQUEST_LIMIT || !agent_signed)) {
        result->agent_failed = true;
        goto fail;
    }
    if (!mob_process_group_empty(runtime->child_pid)) {
        result->cleanup_failed = true;
        goto fail;
    }
    if (actions_ready) {
        posix_spawn_file_actions_destroy(&actions);
    }
    if (attributes_ready) {
        posix_spawnattr_destroy(&attributes);
    }
    if (output_pipe[0] >= 0) {
        close(output_pipe[0]);
    }
    if (error_pipe[0] >= 0) {
        close(error_pipe[0]);
    }
    return true;
fail:
    if (!mob_terminate_child(runtime)) {
        result->cleanup_failed = true;
    }
    if (actions_ready) {
        posix_spawn_file_actions_destroy(&actions);
    }
    if (attributes_ready) {
        posix_spawnattr_destroy(&attributes);
    }
    if (input_pipe[0] >= 0) {
        close(input_pipe[0]);
    }
    if (input_pipe[1] >= 0) {
        close(input_pipe[1]);
    }
    if (output_pipe[0] >= 0) {
        close(output_pipe[0]);
    }
    if (output_pipe[1] >= 0) {
        close(output_pipe[1]);
    }
    if (error_pipe[0] >= 0) {
        close(error_pipe[0]);
    }
    if (error_pipe[1] >= 0) {
        close(error_pipe[1]);
    }
    return false;
}

static bool mob_buffer_contains(const uint8_t *buffer, size_t length, const char *needle) {
    size_t index;
    const size_t needle_length = needle == NULL ? 0U : strlen(needle);
    if (buffer == NULL || needle == NULL || needle_length == 0U || needle_length > length) {
        return false;
    }
    for (index = 0U; index <= length - needle_length; ++index) {
        if (memcmp(buffer + index, needle, needle_length) == 0) {
            return true;
        }
    }
    return false;
}

static const char *mob_classify_child_failure(const mob_child_result *result) {
    if (result == NULL) {
        return "INTERNAL_FAIL_CLOSED";
    }
    if (result->cleanup_failed) {
        return "CLEANUP_FAILED";
    }
    if (result->interrupted || mob_signal_received != 0 ||
        mob_native_platform_cancelled()) {
        return "INTERRUPTED";
    }
    if (result->timed_out) {
        return "SSH_TIMEOUT";
    }
    if (result->agent_failed) {
        return "IDENTITY_AGENT_FAILURE";
    }
    if (result->launch_failed) {
        return "SSH_LAUNCH_FAILURE";
    }
    if (mob_buffer_contains(result->stderr_data, result->stderr_length, "Host key verification failed") ||
        mob_buffer_contains(result->stderr_data, result->stderr_length, "REMOTE HOST IDENTIFICATION HAS CHANGED")) {
        return "SSH_HOST_KEY_REJECTED";
    }
    if (mob_buffer_contains(result->stderr_data, result->stderr_length, "Permission denied (publickey)")) {
        return "SSH_AUTHENTICATION_FAILED";
    }
    return "SSH_TRANSPORT_FAILURE";
}

static mob_parent_result mob_parent_defaults(bool accepted, const char *reason) {
    mob_parent_result result;
    result.accepted_invocation = accepted;
    result.connection_result = "NOT_RUN";
    result.target_binding_result = "NOT_RUN";
    result.host_key_result = "NOT_RUN";
    result.identity_result = "NOT_RUN";
    result.operation_result = "NOT_RUN";
    result.ownership_correlation_result = "NOT_RUN";
    result.live_match_classification = "NOT_RUN";
    result.reason_code = mob_reason_or_internal(reason);
    result.probe_json = NULL;
    result.probe_json_length = 0U;
    return result;
}

bool mob_native_install_signal_handlers(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = mob_signal_handler;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGHUP, &action, NULL) != 0 ||
        signal(SIGPIPE, SIG_IGN) == SIG_ERR) {
        return false;
    }
    return true;
}

void mob_native_reset_interrupt(void) {
    mob_signal_received = 0;
}

bool mob_native_service_integrity_ready(void) {
    return mob_validate_integrity();
}

bool mob_native_run_transport(
    const mob_role_record *record,
    const mob_native_identity *identity,
    uid_t caller_uid,
    mob_native_transport_result *result
) {
    mob_runtime runtime;
    char ssh_config[8192];
    size_t ssh_config_length = 0U;
    mob_child_result child;
    bool cleanup_ok;
    if (record == NULL || identity == NULL || identity->signing_key == NULL ||
        identity->public_blob_length == 0U ||
        identity->public_blob_length > sizeof(identity->public_blob) || result == NULL) {
        return false;
    }
    memset(result, 0, sizeof(*result));
    result->reason_code = "INTERNAL_FAIL_CLOSED";
    memset(&runtime, 0, sizeof(runtime));
    runtime.root_fd = -1;
    runtime.directory_fd = -1;
    runtime.agent_listener = -1;
    runtime.agent_connection = -1;
    runtime.child_pid = -1;
    runtime.cleanup_state = MOB_CLEANUP_INIT;
    memset(ssh_config, 0, sizeof(ssh_config));
    memset(&child, 0, sizeof(child));

    if (!mob_runtime_prepare(
            &runtime,
            record,
            identity->public_blob,
            identity->public_blob_length,
            caller_uid)) {
        result->reason_code = "TEMP_RESOURCE_FAILURE";
        goto finish;
    }
    if (!mob_render_ssh_config(
            record,
            runtime.identity_path,
            runtime.agent_path,
            runtime.known_hosts_path,
            ssh_config,
            sizeof(ssh_config),
            &ssh_config_length)) {
        result->reason_code = "INTERNAL_FAIL_CLOSED";
        goto finish;
    }
    if (!mob_spawn_ssh(&runtime, ssh_config, ssh_config_length, true, NULL, &child)) {
        result->reason_code = mob_classify_child_failure(&child);
        goto finish;
    }
    if (!WIFEXITED(child.wait_status) || WEXITSTATUS(child.wait_status) != 0 ||
        child.stderr_length != 0U ||
        !mob_verify_ssh_effective_config(
            (const char *)child.stdout_data,
            child.stdout_length,
            record,
            runtime.identity_path,
            runtime.agent_path,
            runtime.known_hosts_path)) {
        result->reason_code = "BROKER_INTEGRITY_FAILURE";
        goto finish;
    }
    mob_wipe(&child, sizeof(child));
    result->connection_attempted = true;
    if (!mob_spawn_ssh(&runtime, ssh_config, ssh_config_length, false, identity, &child)) {
        result->reason_code = mob_classify_child_failure(&child);
        goto finish;
    }
    if (!WIFEXITED(child.wait_status) || WEXITSTATUS(child.wait_status) != 0 ||
        child.stderr_length != 0U || child.stdout_length == 0U ||
        child.stdout_length > sizeof(result->remote_output)) {
        result->reason_code = mob_classify_child_failure(&child);
        goto finish;
    }
    result->connection_succeeded = true;
    memcpy(result->remote_output, child.stdout_data, child.stdout_length);
    result->remote_output_length = child.stdout_length;
    result->reason_code = "SUCCESS";

finish:
    cleanup_ok = mob_runtime_cleanup(&runtime);
    result->cleanup_completed = cleanup_ok;
    if (!cleanup_ok) {
        result->connection_succeeded = false;
        result->remote_output_length = 0U;
        memset(result->remote_output, 0, sizeof(result->remote_output));
        result->reason_code = "CLEANUP_FAILED";
    }
    mob_wipe(ssh_config, sizeof(ssh_config));
    mob_wipe(&child, sizeof(child));
    return true;
}

bool mob_native_execute_operation(
    uid_t caller_uid,
    char *output,
    size_t output_capacity,
    size_t *output_length
) {
    const char *reason = "INTERNAL_FAIL_CLOSED";
    mob_parent_result parent = mob_parent_defaults(true, reason);
    CFDataRef role_data = NULL;
    mob_role_record role_record;
    SecKeyRef private_key = NULL;
    uint8_t public_blob[256];
    size_t public_blob_length = 0U;
    mob_native_identity identity;
    mob_native_transport_result transport;
    mob_remote_result remote;
    time_t now;
    bool serialized;
    if (output == NULL || output_length == NULL || output_capacity == 0U ||
        caller_uid == 0U || caller_uid == geteuid()) {
        return false;
    }
    memset(&role_record, 0, sizeof(role_record));
    memset(public_blob, 0, sizeof(public_blob));
    memset(&identity, 0, sizeof(identity));
    memset(&transport, 0, sizeof(transport));
    memset(&remote, 0, sizeof(remote));

    if (!mob_validate_integrity()) {
        parent.reason_code = "BROKER_INTEGRITY_FAILURE";
        goto finish;
    }
    reason = mob_copy_role_record(&role_data);
    if (strcmp(reason, "SUCCESS") != 0 || role_data == NULL) {
        parent.reason_code = mob_reason_or_internal(reason);
        goto finish;
    }
    now = time(NULL);
    if (now <= 0) {
        parent.reason_code = "INTERNAL_FAIL_CLOSED";
        goto finish;
    }
    reason = mob_parse_mobr1(
        CFDataGetBytePtr(role_data),
        (size_t)CFDataGetLength(role_data),
        (uint64_t)now,
        MOB_BROKER_BUILD,
        &role_record
    );
    if (strcmp(reason, "SUCCESS") != 0) {
        parent.reason_code = mob_reason_or_internal(reason);
        if (strcmp(reason, "TARGET_BINDING_REJECTED") == 0) {
            parent.target_binding_result = "REJECTED";
        } else if (strcmp(reason, "HOST_KEY_BINDING_REJECTED") == 0) {
            parent.host_key_result = "REJECTED";
        } else if (strcmp(reason, "IDENTITY_BINDING_REJECTED") == 0) {
            parent.identity_result = "REJECTED";
        }
        goto finish;
    }
    parent.target_binding_result = "MATCH";
    parent.host_key_result = "MATCH";
    reason = mob_copy_identity(
        &role_record,
        &private_key,
        public_blob,
        sizeof(public_blob),
        &public_blob_length
    );
    if (strcmp(reason, "SUCCESS") != 0 || private_key == NULL) {
        parent.identity_result = "REJECTED";
        parent.reason_code = mob_reason_or_internal(reason);
        goto finish;
    }
    parent.identity_result = "MATCH";
    identity.signing_key = private_key;
    memcpy(identity.public_blob, public_blob, public_blob_length);
    identity.public_blob_length = public_blob_length;
    if (!mob_native_run_transport(&role_record, &identity, caller_uid, &transport)) {
        parent.reason_code = "INTERNAL_FAIL_CLOSED";
        goto finish;
    }
    if (transport.connection_attempted) {
        parent.connection_result = "FAILED";
    }
    if (strcmp(transport.reason_code, "SUCCESS") != 0 ||
        !transport.connection_succeeded) {
        parent.reason_code = mob_reason_or_internal(transport.reason_code);
        goto finish;
    }
    parent.connection_result = "SUCCESS";
    reason = mob_parse_mor1(
        transport.remote_output,
        transport.remote_output_length,
        &remote);
    if (strcmp(reason, "SUCCESS") != 0) {
        parent.operation_result = "FAILED";
        parent.ownership_correlation_result = "UNKNOWN";
        parent.live_match_classification = "UNKNOWN";
        parent.reason_code = "REMOTE_OUTPUT_INVALID_OR_OVERSIZED";
        goto finish;
    }
    parent.operation_result = remote.operation_result;
    parent.ownership_correlation_result = remote.ownership_result;
    parent.live_match_classification = remote.live_match_classification;
    parent.reason_code = remote.reason_code;
    parent.probe_json = remote.probe_json_length == 0U ? NULL : remote.probe_json;
    parent.probe_json_length = remote.probe_json_length;
finish:
    if (role_data != NULL) {
        CFRelease(role_data);
    }
    if (private_key != NULL) {
        CFRelease(private_key);
    }
    serialized = mob_serialize_parent_json(
        &parent,
        output,
        output_capacity,
        output_length);
    mob_wipe(&role_record, sizeof(role_record));
    mob_wipe(public_blob, sizeof(public_blob));
    mob_wipe(&identity, sizeof(identity));
    mob_wipe(&transport, sizeof(transport));
    mob_wipe(&remote, sizeof(remote));
    return serialized;
}
