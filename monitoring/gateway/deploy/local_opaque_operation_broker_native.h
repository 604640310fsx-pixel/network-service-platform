#ifndef NETWORK_SERVICE_PLATFORM_LOCAL_OPAQUE_OPERATION_BROKER_NATIVE_H
#define NETWORK_SERVICE_PLATFORM_LOCAL_OPAQUE_OPERATION_BROKER_NATIVE_H

#include "local_opaque_operation_broker_core.h"

#include <CoreFoundation/CoreFoundation.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define MOB_NATIVE_PUBLIC_KEY_MAX_BYTES 256U
#define MOB_NATIVE_RATE_WINDOW_SECONDS 60.0
#define MOB_NATIVE_PER_UID_RATE_LIMIT 2U
#define MOB_NATIVE_GLOBAL_RATE_LIMIT 4U

typedef struct {
    void *signing_key;
    uint8_t public_blob[MOB_NATIVE_PUBLIC_KEY_MAX_BYTES];
    size_t public_blob_length;
} mob_native_identity;

typedef struct {
    bool connection_attempted;
    bool connection_succeeded;
    bool cleanup_completed;
    const char *reason_code;
    uint8_t remote_output[MOB_MOR1_MAX_BYTES];
    size_t remote_output_length;
} mob_native_transport_result;

typedef struct {
    bool message_code_created;
    bool dynamic_validity_passed;
    bool exact_path_passed;
    bool secure_path_passed;
    bool identifier_passed;
    bool team_identifier_passed;
    bool cdhash_passed;
    bool designated_requirement_passed;
    bool hardened_runtime_present;
    bool ad_hoc_absent;
    bool get_task_allow_safe;
} mob_native_peer_evidence;

typedef struct {
    double per_uid_starts[MOB_NATIVE_PER_UID_RATE_LIMIT];
    size_t per_uid_start_count;
    double global_starts[MOB_NATIVE_GLOBAL_RATE_LIMIT];
    size_t global_start_count;
} mob_native_rate_state;

bool mob_native_connection_euid_allowed(uid_t peer_euid, uid_t authorized_euid, uid_t service_euid);
bool mob_native_peer_evidence_valid(const mob_native_peer_evidence *evidence);
bool mob_native_peer_request_authorized(
    uid_t peer_euid,
    uid_t authorized_euid,
    uid_t service_euid,
    bool schema_valid,
    const mob_native_peer_evidence *evidence
);
bool mob_native_key_capabilities_exact(CFDictionaryRef attributes);
bool mob_native_admin_action_supported(uint32_t action);
bool mob_native_request_once(bool *request_seen);
bool mob_native_rate_gate_accept(
    mob_native_rate_state *state,
    bool operation_active,
    double now
);

bool mob_native_install_signal_handlers(void);
void mob_native_reset_interrupt(void);
bool mob_native_service_integrity_ready(void);

bool mob_native_run_transport(
    const mob_role_record *record,
    const mob_native_identity *identity,
    uid_t caller_uid,
    mob_native_transport_result *result
);

bool mob_native_execute_operation(
    uid_t caller_uid,
    char *output,
    size_t output_capacity,
    size_t *output_length
);

/* Fixed production definitions are linked from the native implementation.
 * The repository-only harness supplies strong test-target definitions. */
const char *mob_native_platform_child_path(void);
const char *mob_native_platform_runtime_root(void);
double mob_native_platform_timeout_seconds(bool verify_only);
bool mob_native_platform_cancelled(void);
bool mob_native_platform_sign_der(
    void *signing_key,
    const uint8_t *message,
    size_t message_length,
    uint8_t *signature,
    size_t signature_capacity,
    size_t *signature_length
);

#endif
