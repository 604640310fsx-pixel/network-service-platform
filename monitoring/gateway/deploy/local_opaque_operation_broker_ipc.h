#ifndef NETWORK_SERVICE_PLATFORM_LOCAL_OPAQUE_OPERATION_BROKER_IPC_H
#define NETWORK_SERVICE_PLATFORM_LOCAL_OPAQUE_OPERATION_BROKER_IPC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <xpc/xpc.h>

#define MOB_MACH_SERVICE "com.network-service-platform.monitor-opaque-operation-broker.v1"
#define MOB_CLIENT_PATH "/usr/local/libexec/network-service-platform/monitor-opaque-operation-broker-v1"
#define MOB_SERVICE_PATH "/usr/local/libexec/network-service-platform/monitor-opaque-operation-broker-service-v1"
#define MOB_ADMIN_PATH "/usr/local/libexec/network-service-platform/monitor-opaque-operation-broker-admin-v1"
#define MOB_SERVICE_ACCOUNT "_nsp_mob"
#define MOB_SERVICE_RUNTIME_ROOT "/private/var/run/network-service-platform/monitor-opaque-operation-broker-v1"
#define MOB_SYSTEM_KEYCHAIN_PATH "/Library/Keychains/System.keychain"

#define MOB_IPC_VERSION 1ULL
#define MOB_IPC_RESULT_MAX_BYTES 65536U
#define MOB_IPC_KEY_VERSION "version"
#define MOB_IPC_KEY_ROLE "role"
#define MOB_IPC_KEY_OPERATION "operation"
#define MOB_IPC_KEY_RESULT "result"

#define MOB_INTERNAL_FAILURE_JSON \
    "{\"schemaVersion\":\"LOCAL-OPAQUE-OPERATION-BROKER-RESULT-V1\"," \
    "\"role\":\"FNOS_PRODUCTION\",\"operation\":" \
    "\"RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1\"," \
    "\"connectionResult\":\"NOT_RUN\",\"targetBindingResult\":\"NOT_RUN\"," \
    "\"hostKeyResult\":\"NOT_RUN\",\"identityResult\":\"NOT_RUN\"," \
    "\"operationResult\":\"NOT_RUN\",\"ownershipCorrelationResult\":\"NOT_RUN\"," \
    "\"liveMatchClassification\":\"NOT_RUN\",\"productionWrite\":\"NONE\"," \
    "\"serviceActions\":0,\"permissionDelta\":\"NONE\"," \
    "\"reasonCode\":\"INTERNAL_FAIL_CLOSED\",\"probeDiagnostic\":null}"

bool mob_validate_parent_json(const char *input, size_t input_length);

static inline bool mob_ipc_request_is_exact(xpc_object_t request) {
    xpc_object_t version;
    xpc_object_t role;
    xpc_object_t operation;
    if (request == NULL || xpc_get_type(request) != XPC_TYPE_DICTIONARY ||
        xpc_dictionary_get_count(request) != 3U) {
        return false;
    }
    version = xpc_dictionary_get_value(request, MOB_IPC_KEY_VERSION);
    role = xpc_dictionary_get_value(request, MOB_IPC_KEY_ROLE);
    operation = xpc_dictionary_get_value(request, MOB_IPC_KEY_OPERATION);
    return version != NULL && xpc_get_type(version) == XPC_TYPE_UINT64 &&
           xpc_uint64_get_value(version) == MOB_IPC_VERSION &&
           role != NULL && xpc_get_type(role) == XPC_TYPE_STRING &&
           strcmp(xpc_string_get_string_ptr(role), "FNOS_PRODUCTION") == 0 &&
           operation != NULL && xpc_get_type(operation) == XPC_TYPE_STRING &&
           strcmp(
               xpc_string_get_string_ptr(operation),
               "RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1") == 0;
}

static inline xpc_object_t mob_ipc_create_request(void) {
    xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0U);
    if (request == NULL) {
        return NULL;
    }
    xpc_dictionary_set_uint64(request, MOB_IPC_KEY_VERSION, MOB_IPC_VERSION);
    xpc_dictionary_set_string(request, MOB_IPC_KEY_ROLE, "FNOS_PRODUCTION");
    xpc_dictionary_set_string(
        request,
        MOB_IPC_KEY_OPERATION,
        "RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1");
    return request;
}

static inline bool mob_ipc_response_is_exact(
    xpc_object_t response,
    const void **result,
    size_t *result_length
) {
    xpc_object_t version;
    xpc_object_t data;
    const void *bytes;
    size_t length = 0U;
    if (result == NULL || result_length == NULL || response == NULL ||
        xpc_get_type(response) != XPC_TYPE_DICTIONARY ||
        xpc_dictionary_get_count(response) != 2U) {
        return false;
    }
    version = xpc_dictionary_get_value(response, MOB_IPC_KEY_VERSION);
    data = xpc_dictionary_get_value(response, MOB_IPC_KEY_RESULT);
    if (version == NULL || xpc_get_type(version) != XPC_TYPE_UINT64 ||
        xpc_uint64_get_value(version) != MOB_IPC_VERSION ||
        data == NULL || xpc_get_type(data) != XPC_TYPE_DATA) {
        return false;
    }
    bytes = xpc_dictionary_get_data(response, MOB_IPC_KEY_RESULT, &length);
    if (bytes == NULL || length == 0U || length > MOB_IPC_RESULT_MAX_BYTES ||
        memchr(bytes, '\0', length) != NULL) {
        return false;
    }
    *result = bytes;
    *result_length = length;
    return true;
}

static inline xpc_object_t mob_ipc_create_response(
    xpc_object_t request,
    const void *result,
    size_t result_length
) {
    xpc_object_t response;
    if (request == NULL || result == NULL || result_length == 0U ||
        result_length > MOB_IPC_RESULT_MAX_BYTES) {
        return NULL;
    }
    response = xpc_dictionary_create_reply(request);
    if (response == NULL) {
        return NULL;
    }
    xpc_dictionary_set_uint64(response, MOB_IPC_KEY_VERSION, MOB_IPC_VERSION);
    xpc_dictionary_set_data(response, MOB_IPC_KEY_RESULT, result, result_length);
    return response;
}

#endif
