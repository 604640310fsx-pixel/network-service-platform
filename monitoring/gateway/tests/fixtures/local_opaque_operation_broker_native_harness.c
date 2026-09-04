#define _DARWIN_C_SOURCE 1

#include "local_opaque_operation_broker_core.h"
#include "local_opaque_operation_broker_ipc.h"
#include "local_opaque_operation_broker_native.h"

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define HARNESS_BUFFER_BYTES 65536U

extern char **environ;

static char harness_child_path[PATH_MAX];
static char harness_runtime_root[PATH_MAX];
static char harness_mode[32];
static unsigned int harness_sign_count;

static bool harness_environment_is_empty_or_runtime_only(void) {
    size_t count = 0U;
    if (environ == NULL) {
        return true;
    }
    while (environ[count] != NULL) {
        if (strncmp(environ[count], "__CF_USER_TEXT_ENCODING=", 24U) != 0 || count != 0U) {
            return false;
        }
        ++count;
    }
    return true;
}

const char *mob_native_platform_child_path(void) {
    return harness_child_path;
}

const char *mob_native_platform_runtime_root(void) {
    return harness_runtime_root;
}

double mob_native_platform_timeout_seconds(bool verify_only) {
    if (verify_only) {
        return 2.0;
    }
    return strcmp(harness_mode, "timeout") == 0 ? 0.25 : 3.0;
}

bool mob_native_platform_cancelled(void) {
    return false;
}

bool mob_native_platform_sign_der(
    void *signing_key,
    const uint8_t *message,
    size_t message_length,
    uint8_t *signature,
    size_t signature_capacity,
    size_t *signature_length
) {
    static const uint8_t fixed_der[] = {
        0x30U, 0x44U, 0x02U, 0x20U,
        0x01U, 0x02U, 0x03U, 0x04U, 0x05U, 0x06U, 0x07U, 0x08U,
        0x09U, 0x0aU, 0x0bU, 0x0cU, 0x0dU, 0x0eU, 0x0fU, 0x10U,
        0x11U, 0x12U, 0x13U, 0x14U, 0x15U, 0x16U, 0x17U, 0x18U,
        0x19U, 0x1aU, 0x1bU, 0x1cU, 0x1dU, 0x1eU, 0x1fU, 0x20U,
        0x02U, 0x20U,
        0x21U, 0x22U, 0x23U, 0x24U, 0x25U, 0x26U, 0x27U, 0x28U,
        0x29U, 0x2aU, 0x2bU, 0x2cU, 0x2dU, 0x2eU, 0x2fU, 0x30U,
        0x31U, 0x32U, 0x33U, 0x34U, 0x35U, 0x36U, 0x37U, 0x38U,
        0x39U, 0x3aU, 0x3bU, 0x3cU, 0x3dU, 0x3eU, 0x3fU, 0x40U,
    };
    if (signing_key == NULL || message == NULL || message_length == 0U ||
        signature == NULL || signature_length == NULL ||
        signature_capacity < sizeof(fixed_der)) {
        return false;
    }
    memcpy(signature, fixed_der, sizeof(fixed_der));
    *signature_length = sizeof(fixed_der);
    ++harness_sign_count;
    return true;
}

static uint32_t harness_read_u32(const uint8_t value[4]) {
    return ((uint32_t)value[0] << 24U) |
           ((uint32_t)value[1] << 16U) |
           ((uint32_t)value[2] << 8U) |
           (uint32_t)value[3];
}

static void harness_write_u32(uint8_t output[4], uint32_t value) {
    output[0] = (uint8_t)(value >> 24U);
    output[1] = (uint8_t)(value >> 16U);
    output[2] = (uint8_t)(value >> 8U);
    output[3] = (uint8_t)value;
}

static bool harness_write_all(int descriptor, const uint8_t *data, size_t length) {
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

static bool harness_read_exact(int descriptor, uint8_t *data, size_t length) {
    size_t offset = 0U;
    while (offset < length) {
        const ssize_t received = read(descriptor, data + offset, length - offset);
        if (received < 0 && errno == EINTR) {
            continue;
        }
        if (received <= 0) {
            return false;
        }
        offset += (size_t)received;
    }
    return true;
}

static bool harness_read_stdin(char *output, size_t capacity, size_t *length) {
    size_t offset = 0U;
    while (offset < capacity) {
        const ssize_t received = read(STDIN_FILENO, output + offset, capacity - offset);
        if (received < 0 && errno == EINTR) {
            continue;
        }
        if (received < 0) {
            return false;
        }
        if (received == 0) {
            *length = offset;
            return offset > 0U;
        }
        offset += (size_t)received;
    }
    return false;
}

static bool harness_append(
    uint8_t *output,
    size_t capacity,
    size_t *offset,
    const uint8_t *value,
    size_t length
) {
    if (output == NULL || offset == NULL || value == NULL || length > UINT32_MAX ||
        *offset > capacity || capacity - *offset < length + 4U) {
        return false;
    }
    harness_write_u32(output + *offset, (uint32_t)length);
    memcpy(output + *offset + 4U, value, length);
    *offset += 4U + length;
    return true;
}

static bool harness_send_packet(int descriptor, const uint8_t *payload, size_t length) {
    uint8_t header[4];
    if (length == 0U || length > UINT32_MAX) {
        return false;
    }
    harness_write_u32(header, (uint32_t)length);
    return harness_write_all(descriptor, header, sizeof(header)) &&
           harness_write_all(descriptor, payload, length);
}

static bool harness_receive_packet(
    int descriptor,
    uint8_t *payload,
    size_t capacity,
    size_t *length
) {
    uint8_t header[4];
    uint32_t packet_length;
    if (!harness_read_exact(descriptor, header, sizeof(header))) {
        return false;
    }
    packet_length = harness_read_u32(header);
    if (packet_length == 0U || packet_length > capacity ||
        !harness_read_exact(descriptor, payload, packet_length)) {
        return false;
    }
    *length = packet_length;
    return true;
}

static bool harness_find_config_value(
    const char *config,
    size_t config_length,
    const char *key,
    char *output,
    size_t output_capacity
) {
    size_t offset = 0U;
    const size_t key_length = strlen(key);
    while (offset < config_length) {
        size_t line_end = offset;
        while (line_end < config_length && config[line_end] != '\n') {
            ++line_end;
        }
        if (line_end > offset + key_length + 1U &&
            strncasecmp(config + offset, key, key_length) == 0 &&
            config[offset + key_length] == ' ') {
            const size_t length = line_end - offset - key_length - 1U;
            if (length == 0U || length >= output_capacity) {
                return false;
            }
            memcpy(output, config + offset + key_length + 1U, length);
            output[length] = '\0';
            return true;
        }
        offset = line_end < config_length ? line_end + 1U : line_end;
    }
    return false;
}

static bool harness_emit_effective_config(const char *config, size_t config_length) {
    char output[16384];
    size_t input_offset = 0U;
    size_t output_offset = 0U;
    while (input_offset < config_length) {
        size_t line_end = input_offset;
        size_t separator;
        size_t index;
        const char *value;
        size_t value_length;
        while (line_end < config_length && config[line_end] != '\n') {
            ++line_end;
        }
        separator = input_offset;
        while (separator < line_end && config[separator] != ' ') {
            ++separator;
        }
        if (separator == input_offset || separator == line_end) {
            return false;
        }
        value = config + separator + 1U;
        value_length = line_end - separator - 1U;
        if (strncasecmp(config + input_offset, "RequestTTY", 10U) == 0) {
            value = "false";
            value_length = 5U;
        }
        if (output_offset + (separator - input_offset) + value_length + 2U > sizeof(output)) {
            return false;
        }
        for (index = input_offset; index < separator; ++index) {
            char character = config[index];
            if (character >= 'A' && character <= 'Z') {
                character = (char)(character + ('a' - 'A'));
            }
            output[output_offset++] = character;
        }
        output[output_offset++] = ' ';
        memcpy(output + output_offset, value, value_length);
        output_offset += value_length;
        output[output_offset++] = '\n';
        input_offset = line_end < config_length ? line_end + 1U : line_end;
    }
    return harness_write_all(STDOUT_FILENO, (const uint8_t *)output, output_offset);
}

static int harness_connect_agent(const char *path) {
    int descriptor;
    struct sockaddr_un address;
    descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
    if (descriptor < 0) {
        return -1;
    }
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(address.sun_path)) {
        close(descriptor);
        return -1;
    }
    memcpy(address.sun_path, path, strlen(path) + 1U);
    if (connect(descriptor, (const struct sockaddr *)&address, sizeof(address)) != 0) {
        close(descriptor);
        return -1;
    }
    return descriptor;
}

static bool harness_agent_identities(
    int descriptor,
    uint8_t *public_key,
    size_t public_key_capacity,
    size_t *public_key_length
) {
    static const uint8_t request[] = {11U};
    uint8_t response[HARNESS_BUFFER_BYTES];
    size_t response_length = 0U;
    uint32_t key_length;
    if (!harness_send_packet(descriptor, request, sizeof(request)) ||
        !harness_receive_packet(descriptor, response, sizeof(response), &response_length) ||
        response_length < 9U || response[0] != 12U ||
        harness_read_u32(response + 1U) != 1U) {
        return false;
    }
    key_length = harness_read_u32(response + 5U);
    if (key_length == 0U || (size_t)key_length > public_key_capacity ||
        (size_t)key_length > response_length - 9U) {
        return false;
    }
    memcpy(public_key, response + 9U, key_length);
    *public_key_length = (size_t)key_length;
    return true;
}

static bool harness_agent_sign(
    int descriptor,
    const uint8_t *public_key,
    size_t public_key_length,
    uint32_t flags,
    size_t data_length
) {
    uint8_t request[HARNESS_BUFFER_BYTES];
    uint8_t response[HARNESS_BUFFER_BYTES];
    uint8_t data[32769];
    size_t request_length = 1U;
    size_t response_length = 0U;
    memset(data, 0x5a, sizeof(data));
    request[0] = 13U;
    if (!harness_append(
            request,
            sizeof(request),
            &request_length,
            public_key,
            public_key_length) ||
        !harness_append(
            request,
            sizeof(request),
            &request_length,
            data,
            data_length) ||
        request_length > sizeof(request) - 4U) {
        return false;
    }
    harness_write_u32(request + request_length, flags);
    request_length += 4U;
    if (!harness_send_packet(descriptor, request, request_length) ||
        !harness_receive_packet(descriptor, response, sizeof(response), &response_length)) {
        return false;
    }
    return response_length > 5U && response[0] == 14U;
}

static bool harness_emit_remote_result(void) {
    mob_remote_result remote;
    uint8_t encoded[MOB_MOR1_MAX_BYTES];
    size_t encoded_length = 0U;
    memset(&remote, 0, sizeof(remote));
    strlcpy(remote.operation_result, "FAILED", sizeof(remote.operation_result));
    strlcpy(remote.ownership_result, "UNKNOWN", sizeof(remote.ownership_result));
    strlcpy(remote.live_match_classification, "UNKNOWN", sizeof(remote.live_match_classification));
    strlcpy(remote.reason_code, "REMOTE_OPERATION_FAILED", sizeof(remote.reason_code));
    if (!mob_encode_mor1(&remote, encoded, sizeof(encoded), &encoded_length)) {
        return false;
    }
    return harness_write_all(STDOUT_FILENO, encoded, encoded_length);
}

static int harness_child(int argc, char **argv) {
    char config[16384];
    size_t config_length = 0U;
    const char *name = strrchr(argv[0], '/');
    const char *mode;
    bool verify_only;
    if (name == NULL) {
        return 72;
    }
    mode = name + 1;
    if (strncmp(mode, "stub-", 5U) != 0) {
        return 73;
    }
    if (!harness_environment_is_empty_or_runtime_only()) {
        return 74;
    }
    if (getpgrp() != getpid()) {
        return 75;
    }
    if (!harness_read_stdin(config, sizeof(config), &config_length)) {
        return 76;
    }
    mode += 5U;
    verify_only = argc == 5 && strcmp(argv[1], "-G") == 0 &&
        strcmp(argv[2], "-F") == 0 && strcmp(argv[3], "/dev/stdin") == 0 &&
        strcmp(argv[4], "broker-fnos-v1") == 0;
    if (verify_only) {
        return harness_emit_effective_config(config, config_length) ? 0 : 71;
    }
    if (argc != 4 || strcmp(argv[1], "-F") != 0 ||
        strcmp(argv[2], "/dev/stdin") != 0 ||
        strcmp(argv[3], "broker-fnos-v1") != 0) {
        return 71;
    }
    if (strcmp(mode, "sigint") == 0) {
        (void)kill(getppid(), SIGINT);
    } else if (strcmp(mode, "sigterm") == 0) {
        (void)kill(getppid(), SIGTERM);
    } else if (strcmp(mode, "sighup") == 0) {
        (void)kill(getppid(), SIGHUP);
    }
    if (strcmp(mode, "timeout") == 0 || strncmp(mode, "sig", 3U) == 0) {
        (void)sleep(10U);
        return 71;
    }
    char agent_path[PATH_MAX];
    if (!harness_find_config_value(
            config,
            config_length,
            "IdentityAgent",
            agent_path,
            sizeof(agent_path))) {
        return 71;
    }
    if (strcmp(mode, "wrong-peer") == 0) {
        const pid_t nested = fork();
        if (nested < 0) {
            return 71;
        }
        if (nested == 0) {
            const int nested_socket = harness_connect_agent(agent_path);
            uint8_t key[512];
            size_t key_length = 0U;
            const bool ok = nested_socket >= 0 &&
                harness_agent_identities(nested_socket, key, sizeof(key), &key_length);
            if (nested_socket >= 0) {
                close(nested_socket);
            }
            _exit(ok ? 0 : 71);
        }
        while (waitpid(nested, NULL, 0) < 0 && errno == EINTR) {
        }
        return 71;
    }
    int agent = harness_connect_agent(agent_path);
    uint8_t key[512];
    size_t key_length = 0U;
    if (agent < 0 || !harness_agent_identities(agent, key, sizeof(key), &key_length)) {
        if (agent >= 0) {
            close(agent);
        }
        return 71;
    }
    if (strcmp(mode, "second-connection") == 0) {
        const int second = harness_connect_agent(agent_path);
        if (second >= 0) {
            (void)sleep(1U);
            close(second);
        }
        close(agent);
        return 71;
    }
    if (strcmp(mode, "request-limit") == 0) {
        unsigned int index;
        for (index = 1U; index < 17U; ++index) {
            if (!harness_agent_identities(agent, key, sizeof(key), &key_length)) {
                close(agent);
                return 71;
            }
        }
        close(agent);
        return 71;
    }
    if (strcmp(mode, "wrong-key") == 0) {
        key[0] ^= 0xffU;
    }
    const uint32_t flags = strcmp(mode, "nonzero-flags") == 0 ? 1U : 0U;
    const size_t data_length = strcmp(mode, "oversized-data") == 0 ? 32769U : 32U;
    const bool signed_ok = harness_agent_sign(
        agent,
        key,
        key_length,
        flags,
        data_length);
    close(agent);
    if (strcmp(mode, "orphan") == 0 && signed_ok) {
        const pid_t orphan = fork();
        if (orphan < 0) {
            return 71;
        }
        if (orphan == 0) {
            close(STDIN_FILENO);
            close(STDOUT_FILENO);
            close(STDERR_FILENO);
            (void)sleep(10U);
            _exit(0);
        }
    }
    if ((strcmp(mode, "normal") != 0 && strcmp(mode, "orphan") != 0) || !signed_ok) {
        return 71;
    }
    return harness_emit_remote_result() ? 0 : 71;
}

static bool harness_root_empty(const char *path) {
    DIR *directory = opendir(path);
    struct dirent *entry;
    bool empty = true;
    if (directory == NULL) {
        return false;
    }
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
            empty = false;
            break;
        }
    }
    closedir(directory);
    return empty;
}

static bool harness_peer_and_capability_matrix(void) {
    mob_native_peer_evidence evidence;
    mob_native_rate_state rate_state;
    bool request_seen = false;
    bool *fields;
    size_t index;
    unsigned int failure_resource_accesses = 0U;
    const void *keys[] = {
        kSecAttrIsPermanent,
        kSecAttrIsExtractable,
        kSecAttrCanSign,
        kSecAttrCanDecrypt,
        kSecAttrCanDerive,
        kSecAttrCanEncrypt,
        kSecAttrCanUnwrap,
        kSecAttrCanWrap,
        kSecAttrCanVerify,
    };
    const void *values[] = {
        kCFBooleanTrue,
        kCFBooleanFalse,
        kCFBooleanTrue,
        kCFBooleanFalse,
        kCFBooleanFalse,
        kCFBooleanFalse,
        kCFBooleanFalse,
        kCFBooleanFalse,
        kCFBooleanFalse,
    };
    memset(&rate_state, 0, sizeof(rate_state));
    if (!mob_native_request_once(&request_seen) ||
        mob_native_request_once(&request_seen) ||
        mob_native_rate_gate_accept(&rate_state, false, NAN) ||
        mob_native_rate_gate_accept(&rate_state, false, INFINITY) ||
        !mob_native_connection_euid_allowed(501U, 501U, 502U) ||
        mob_native_connection_euid_allowed(500U, 501U, 502U) ||
        mob_native_connection_euid_allowed(0U, 0U, 502U) ||
        mob_native_connection_euid_allowed(502U, 502U, 502U) ||
        !mob_native_rate_gate_accept(&rate_state, false, 1.0) ||
        mob_native_rate_gate_accept(&rate_state, true, 2.0) ||
        !mob_native_rate_gate_accept(&rate_state, false, 2.0) ||
        mob_native_rate_gate_accept(&rate_state, false, 3.0) ||
        !mob_native_rate_gate_accept(&rate_state, false, 61.0) ||
        !mob_native_admin_action_supported(0U) ||
        mob_native_admin_action_supported(1U) ||
        !mob_native_admin_action_supported(2U) ||
        mob_native_admin_action_supported(3U)) {
        return false;
    }
    memset(&rate_state, 0, sizeof(rate_state));
    rate_state.global_start_count = MOB_NATIVE_GLOBAL_RATE_LIMIT;
    for (index = 0U; index < MOB_NATIVE_GLOBAL_RATE_LIMIT; ++index) {
        rate_state.global_starts[index] = 1.0;
    }
    if (mob_native_rate_gate_accept(&rate_state, false, 2.0)) {
        return false;
    }
    memset(&evidence, 1, sizeof(evidence));
    if (!mob_native_peer_evidence_valid(&evidence) ||
        !mob_native_peer_request_authorized(501U, 501U, 502U, true, &evidence) ||
        mob_native_peer_request_authorized(501U, 501U, 502U, false, &evidence) ||
        mob_native_peer_request_authorized(500U, 501U, 502U, true, &evidence) ||
        mob_native_peer_request_authorized(501U, 501U, 501U, true, &evidence)) {
        return false;
    }
    fields = (bool *)&evidence;
    for (index = 0U; index < sizeof(evidence) / sizeof(bool); ++index) {
        const bool saved = fields[index];
        fields[index] = false;
        if (mob_native_peer_request_authorized(501U, 501U, 502U, true, &evidence)) {
            ++failure_resource_accesses;
        }
        fields[index] = saved;
    }
    if (failure_resource_accesses != 0U) {
        return false;
    }
    CFDictionaryRef valid = CFDictionaryCreate(
        kCFAllocatorDefault,
        keys,
        values,
        (CFIndex)(sizeof(keys) / sizeof(keys[0])),
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    if (valid == NULL || !mob_native_key_capabilities_exact(valid)) {
        if (valid != NULL) {
            CFRelease(valid);
        }
        return false;
    }
    CFRelease(valid);
    for (index = 0U; index < sizeof(keys) / sizeof(keys[0]); ++index) {
        const void *short_keys[8];
        const void *short_values[8];
        const void *wrong_values[9];
        size_t read_index;
        size_t write_index = 0U;
        for (read_index = 0U; read_index < sizeof(keys) / sizeof(keys[0]); ++read_index) {
            if (read_index != index) {
                short_keys[write_index] = keys[read_index];
                short_values[write_index++] = values[read_index];
            }
        }
        CFDictionaryRef missing = CFDictionaryCreate(
            kCFAllocatorDefault,
            short_keys,
            short_values,
            (CFIndex)write_index,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks);
        if (missing == NULL || mob_native_key_capabilities_exact(missing)) {
            if (missing != NULL) {
                CFRelease(missing);
            }
            return false;
        }
        CFRelease(missing);
        memcpy(wrong_values, values, sizeof(wrong_values));
        wrong_values[index] = values[index] == kCFBooleanTrue ? kCFBooleanFalse : kCFBooleanTrue;
        CFDictionaryRef wrong_boolean = CFDictionaryCreate(
            kCFAllocatorDefault,
            keys,
            wrong_values,
            (CFIndex)(sizeof(keys) / sizeof(keys[0])),
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks);
        if (wrong_boolean == NULL || mob_native_key_capabilities_exact(wrong_boolean)) {
            if (wrong_boolean != NULL) {
                CFRelease(wrong_boolean);
            }
            return false;
        }
        CFRelease(wrong_boolean);
        wrong_values[index] = CFSTR("boolean-looking-string");
        CFDictionaryRef wrong_type = CFDictionaryCreate(
            kCFAllocatorDefault,
            keys,
            wrong_values,
            (CFIndex)(sizeof(keys) / sizeof(keys[0])),
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks);
        if (wrong_type == NULL || mob_native_key_capabilities_exact(wrong_type)) {
            if (wrong_type != NULL) {
                CFRelease(wrong_type);
            }
            return false;
        }
        CFRelease(wrong_type);
    }
    return true;
}

static bool harness_ipc_matrix(void) {
    xpc_object_t request = mob_ipc_create_request();
    xpc_object_t response = NULL;
    const void *result = NULL;
    size_t result_length = 0U;
    bool valid = request != NULL && mob_ipc_request_is_exact(request);
    if (!valid) {
        return false;
    }
    xpc_dictionary_set_uint64(request, MOB_IPC_KEY_VERSION, MOB_IPC_VERSION + 1U);
    valid = !mob_ipc_request_is_exact(request);
    xpc_release(request);
    request = mob_ipc_create_request();
    if (!valid || request == NULL) {
        return false;
    }
    xpc_dictionary_set_string(request, MOB_IPC_KEY_VERSION, "1");
    valid = !mob_ipc_request_is_exact(request);
    xpc_release(request);
    request = mob_ipc_create_request();
    if (!valid || request == NULL) {
        return false;
    }
    xpc_dictionary_set_string(request, MOB_IPC_KEY_ROLE, "FNOS_PRODUCTION_COPY");
    valid = !mob_ipc_request_is_exact(request);
    xpc_release(request);
    request = mob_ipc_create_request();
    if (!valid || request == NULL) {
        return false;
    }
    xpc_dictionary_set_string(request, MOB_IPC_KEY_OPERATION, "GENERIC_EXEC");
    valid = !mob_ipc_request_is_exact(request);
    xpc_release(request);
    request = mob_ipc_create_request();
    if (!valid || request == NULL) {
        return false;
    }
    xpc_dictionary_set_value(request, MOB_IPC_KEY_ROLE, NULL);
    valid = !mob_ipc_request_is_exact(request);
    xpc_release(request);
    request = mob_ipc_create_request();
    if (!valid || request == NULL) {
        return false;
    }
    xpc_dictionary_set_string(request, "path", "/synthetic");
    valid = !mob_ipc_request_is_exact(request);
    xpc_release(request);
    request = mob_ipc_create_request();
    if (!valid || request == NULL) {
        return false;
    }
    xpc_dictionary_set_fd(request, "fd", STDIN_FILENO);
    valid = !mob_ipc_request_is_exact(request);
    xpc_release(request);
    request = mob_ipc_create_request();
    if (!valid || request == NULL) {
        return false;
    }
    xpc_object_t nested = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_value(request, MOB_IPC_KEY_ROLE, nested);
    xpc_release(nested);
    valid = !mob_ipc_request_is_exact(request);
    xpc_release(request);
    request = mob_ipc_create_request();
    if (!valid || request == NULL) {
        return false;
    }
    response = xpc_dictionary_create(NULL, NULL, 0U);
    if (response != NULL) {
        xpc_dictionary_set_uint64(response, MOB_IPC_KEY_VERSION, MOB_IPC_VERSION);
        xpc_dictionary_set_data(
            response,
            MOB_IPC_KEY_RESULT,
            MOB_INTERNAL_FAILURE_JSON,
            strlen(MOB_INTERNAL_FAILURE_JSON));
    }
    valid = response != NULL && mob_ipc_response_is_exact(response, &result, &result_length) &&
        mob_validate_parent_json((const char *)result, result_length);
    if (valid) {
        xpc_dictionary_set_string(response, "extra", "rejected");
        valid = !mob_ipc_response_is_exact(response, &result, &result_length);
    }
    if (response != NULL) {
        xpc_release(response);
    }
    response = xpc_dictionary_create(NULL, NULL, 0U);
    if (response != NULL) {
        xpc_dictionary_set_uint64(response, MOB_IPC_KEY_VERSION, MOB_IPC_VERSION + 1U);
        xpc_dictionary_set_data(
            response,
            MOB_IPC_KEY_RESULT,
            MOB_INTERNAL_FAILURE_JSON,
            strlen(MOB_INTERNAL_FAILURE_JSON));
    }
    valid = valid && response != NULL &&
        !mob_ipc_response_is_exact(response, &result, &result_length);
    if (response != NULL) {
        xpc_release(response);
    }
    response = xpc_dictionary_create(NULL, NULL, 0U);
    if (response != NULL) {
        xpc_dictionary_set_uint64(response, MOB_IPC_KEY_VERSION, MOB_IPC_VERSION);
        xpc_dictionary_set_string(response, MOB_IPC_KEY_RESULT, MOB_INTERNAL_FAILURE_JSON);
    }
    valid = valid && response != NULL &&
        !mob_ipc_response_is_exact(response, &result, &result_length);
    if (response != NULL) {
        xpc_release(response);
    }
    response = xpc_dictionary_create(NULL, NULL, 0U);
    if (response != NULL) {
        xpc_dictionary_set_uint64(response, MOB_IPC_KEY_VERSION, MOB_IPC_VERSION);
        xpc_dictionary_set_data(response, MOB_IPC_KEY_RESULT, "", 0U);
    }
    valid = valid && response != NULL &&
        !mob_ipc_response_is_exact(response, &result, &result_length);
    if (response != NULL) {
        xpc_release(response);
    }
    static const uint8_t nul_result[] = {'{', '}', '\0'};
    response = xpc_dictionary_create(NULL, NULL, 0U);
    if (response != NULL) {
        xpc_dictionary_set_uint64(response, MOB_IPC_KEY_VERSION, MOB_IPC_VERSION);
        xpc_dictionary_set_data(response, MOB_IPC_KEY_RESULT, nul_result, sizeof(nul_result));
    }
    valid = valid && response != NULL &&
        !mob_ipc_response_is_exact(response, &result, &result_length);
    if (response != NULL) {
        xpc_release(response);
    }
    uint8_t *oversized = malloc(MOB_IPC_RESULT_MAX_BYTES + 1U);
    response = xpc_dictionary_create(NULL, NULL, 0U);
    if (oversized != NULL) {
        memset(oversized, 'x', MOB_IPC_RESULT_MAX_BYTES + 1U);
    }
    if (response != NULL && oversized != NULL) {
        xpc_dictionary_set_uint64(response, MOB_IPC_KEY_VERSION, MOB_IPC_VERSION);
        xpc_dictionary_set_data(
            response,
            MOB_IPC_KEY_RESULT,
            oversized,
            MOB_IPC_RESULT_MAX_BYTES + 1U);
    }
    valid = valid && response != NULL && oversized != NULL &&
        !mob_ipc_response_is_exact(response, &result, &result_length);
    if (response != NULL) {
        xpc_release(response);
    }
    free(oversized);
    xpc_release(request);
    return valid;
}

static bool harness_mode_expected(
    const char *mode,
    const mob_native_transport_result *result
) {
    if (strcmp(mode, "normal") == 0) {
        mob_remote_result remote;
        memset(&remote, 0, sizeof(remote));
        return result->connection_attempted && result->connection_succeeded &&
               strcmp(result->reason_code, "SUCCESS") == 0 && harness_sign_count == 1U &&
               strcmp(
                   mob_parse_mor1(
                       result->remote_output,
                       result->remote_output_length,
                       &remote),
                   "SUCCESS") == 0;
    }
    if (strcmp(mode, "timeout") == 0) {
        return result->connection_attempted && !result->connection_succeeded &&
               strcmp(result->reason_code, "SSH_TIMEOUT") == 0;
    }
    if (strcmp(mode, "orphan") == 0) {
        return result->connection_attempted && !result->connection_succeeded &&
               strcmp(result->reason_code, "CLEANUP_FAILED") == 0;
    }
    if (strcmp(mode, "same-service-uid") == 0 || strcmp(mode, "acl-root") == 0 ||
        strcmp(mode, "insecure-root") == 0) {
        return !result->connection_attempted && !result->connection_succeeded &&
               strcmp(result->reason_code, "TEMP_RESOURCE_FAILURE") == 0 &&
               harness_sign_count == 0U;
    }
    if (strncmp(mode, "sig", 3U) == 0) {
        return result->connection_attempted && !result->connection_succeeded &&
               strcmp(result->reason_code, "INTERRUPTED") == 0;
    }
    return result->connection_attempted && !result->connection_succeeded &&
           strcmp(result->reason_code, "IDENTITY_AGENT_FAILURE") == 0;
}

static int harness_parent(int argc, char **argv) {
    mob_role_record record;
    mob_native_identity identity;
    mob_native_transport_result result;
    uid_t caller_uid;
    if (argc != 5 || strlen(argv[2]) >= sizeof(harness_mode) ||
        strlen(argv[3]) >= sizeof(harness_runtime_root) ||
        strlen(argv[4]) >= sizeof(harness_child_path)) {
        return 71;
    }
    memcpy(harness_mode, argv[2], strlen(argv[2]) + 1U);
    memcpy(harness_runtime_root, argv[3], strlen(argv[3]) + 1U);
    memcpy(harness_child_path, argv[4], strlen(argv[4]) + 1U);
    memset(&record, 0, sizeof(record));
    record.version = MOB_RECORD_VERSION;
    strlcpy(record.role, MOB_ROLE, sizeof(record.role));
    strlcpy(record.operation, MOB_OPERATION, sizeof(record.operation));
    strlcpy(record.target_kind, "DNS", sizeof(record.target_kind));
    strlcpy(record.target, "synthetic.example.net", sizeof(record.target));
    record.port = 2222U;
    strlcpy(record.username, "monitor_ops", sizeof(record.username));
    strlcpy(record.host_key_algorithm, MOB_HOST_KEY_ALGORITHM, sizeof(record.host_key_algorithm));
    for (size_t index = 0U; index < sizeof(record.host_key); ++index) {
        record.host_key[index] = (uint8_t)index;
    }
    memset(&identity, 0, sizeof(identity));
    identity.signing_key = (void *)(uintptr_t)1U;
    memcpy(identity.public_blob, "synthetic-public-key", 20U);
    identity.public_blob_length = 20U;
    caller_uid = strcmp(harness_mode, "same-service-uid") == 0
        ? geteuid()
        : (geteuid() == (uid_t)UINT_MAX ? geteuid() - 1U : geteuid() + 1U);
    if (caller_uid == 0U ||
        (caller_uid == geteuid() && strcmp(harness_mode, "same-service-uid") != 0) ||
        !mob_native_install_signal_handlers()) {
        return 71;
    }
    mob_native_reset_interrupt();
    memset(&result, 0, sizeof(result));
    const bool ran = mob_native_run_transport(&record, &identity, caller_uid, &result);
    const bool valid = ran && result.cleanup_completed &&
        harness_mode_expected(harness_mode, &result) &&
        harness_root_empty(harness_runtime_root);
    (void)harness_write_all(
        STDOUT_FILENO,
        (const uint8_t *)(valid ? "PASS\n" : "FAIL\n"),
        5U);
    return valid ? 0 : 71;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--matrix") == 0) {
        const bool valid = harness_peer_and_capability_matrix() && harness_ipc_matrix();
        (void)harness_write_all(
            STDOUT_FILENO,
            (const uint8_t *)(valid ? "PASS\n" : "FAIL\n"),
            5U);
        return valid ? 0 : 71;
    }
    if (argc >= 2 && strcmp(argv[1], "--run") == 0) {
        return harness_parent(argc, argv);
    }
    return harness_child(argc, argv);
}
