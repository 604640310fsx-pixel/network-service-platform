#include "local_opaque_operation_broker_core.h"
#include "local_opaque_operation_broker_ipc.h"

#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <xpc/xpc.h>

static bool mob_client_write_all(int descriptor, const uint8_t *data, size_t length) {
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

static mob_parent_result mob_client_parent_result(bool accepted, const char *reason) {
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

static int mob_client_emit_closed(bool accepted, const char *reason) {
    mob_parent_result result = mob_client_parent_result(accepted, reason);
    char output[MOB_IPC_RESULT_MAX_BYTES];
    size_t output_length = 0U;
    if (!mob_serialize_parent_json(&result, output, sizeof(output), &output_length)) {
        memcpy(output, MOB_INTERNAL_FAILURE_JSON, strlen(MOB_INTERNAL_FAILURE_JSON));
        output_length = strlen(MOB_INTERNAL_FAILURE_JSON);
    }
    if (!mob_client_write_all(STDOUT_FILENO, (const uint8_t *)output, output_length) ||
        !mob_client_write_all(STDOUT_FILENO, (const uint8_t *)"\n", 1U)) {
        return 74;
    }
    return strcmp(result.reason_code, "SUCCESS") == 0 ? 0 : 70;
}

static bool mob_client_result_succeeded(const uint8_t *result, size_t result_length) {
    static const uint8_t marker[] =
        "\"permissionDelta\":\"NONE\",\"reasonCode\":\"SUCCESS\",\"probeDiagnostic\":";
    size_t offset;
    if (result == NULL || result_length < sizeof(marker) - 1U) {
        return false;
    }
    for (offset = 0U; offset <= result_length - (sizeof(marker) - 1U); ++offset) {
        if (memcmp(result + offset, marker, sizeof(marker) - 1U) == 0) {
            return true;
        }
    }
    return false;
}

int main(int argc, char **argv) {
    const char *invocation = mob_validate_invocation(argc, (const char *const *)argv);
    xpc_connection_t connection = NULL;
    xpc_object_t request = NULL;
    xpc_object_t response = NULL;
    const void *result = NULL;
    size_t result_length = 0U;
    int exit_code = 70;
    bool response_emitted = false;
    if (strcmp(invocation, "SUCCESS") != 0) {
        return mob_client_emit_closed(false, invocation);
    }
    connection = xpc_connection_create_mach_service(MOB_MACH_SERVICE, NULL, 0U);
    if (connection == NULL) {
        return mob_client_emit_closed(true, "INTERNAL_FAIL_CLOSED");
    }
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
        (void)event;
    });
    xpc_connection_resume(connection);
    request = mob_ipc_create_request();
    if (request == NULL) {
        goto done;
    }
    response = xpc_connection_send_message_with_reply_sync(connection, request);
    if (!mob_ipc_response_is_exact(response, &result, &result_length) ||
        !mob_validate_parent_json((const char *)result, result_length) ||
        !mob_client_write_all(STDOUT_FILENO, result, result_length) ||
        !mob_client_write_all(STDOUT_FILENO, (const uint8_t *)"\n", 1U)) {
        goto done;
    }
    response_emitted = true;
    exit_code = mob_client_result_succeeded(result, result_length) ? 0 : 70;
done:
    if (response != NULL) {
        xpc_release(response);
    }
    if (request != NULL) {
        xpc_release(request);
    }
    xpc_connection_cancel(connection);
    xpc_release(connection);
    if (!response_emitted) {
        return mob_client_emit_closed(true, "INTERNAL_FAIL_CLOSED");
    }
    return exit_code;
}
