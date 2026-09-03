#ifndef NETWORK_SERVICE_PLATFORM_LOCAL_OPAQUE_OPERATION_BROKER_CORE_H
#define NETWORK_SERVICE_PLATFORM_LOCAL_OPAQUE_OPERATION_BROKER_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define MOB_ROLE "FNOS_PRODUCTION"
#define MOB_OPERATION "RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1"
#define MOB_COMMAND_PROFILE "SERVER_FORCED_COMMAND_V1"
#define MOB_SCHEMA_VERSION "LOCAL-OPAQUE-OPERATION-BROKER-RESULT-V1"
#define MOB_PROBE_SCHEMA_VERSION "MGW-RAW-MONITOR-PROBE-DIAGNOSTIC-V1"
#define MOB_HOST_KEY_ALGORITHM "ssh-ed25519"
#define MOB_IDENTITY_ALGORITHM "ecdsa-sha2-nistp256"
#define MOB_HOST_KEY_ALIAS "broker-fnos-hostkey-v1"

#define MOB_MOBR1_MAX_BYTES 16384U
#define MOB_MOR1_MAX_BYTES 32768U
#define MOB_TARGET_MAX_BYTES 253U
#define MOB_USERNAME_MAX_BYTES 32U
#define MOB_PERSISTENT_REF_MAX_BYTES 4096U
#define MOB_PATH_MAX_BYTES 1024U
#define MOB_PROBE_MAX_RECORDS 64U
#define MOB_BROKER_BUILD 1U
#define MOB_RECORD_VERSION 1U

typedef struct {
    uint32_t version;
    char role[32];
    char operation[64];
    char target_kind[4];
    char target[MOB_TARGET_MAX_BYTES + 1U];
    uint16_t port;
    char username[MOB_USERNAME_MAX_BYTES + 1U];
    char host_key_algorithm[24];
    uint8_t host_key[32];
    uint8_t persistent_key_ref[MOB_PERSISTENT_REF_MAX_BYTES];
    size_t persistent_key_ref_length;
    uint8_t identity_sha256[32];
    char command_profile[32];
    uint64_t expires_at;
    uint32_t minimum_build;
} mob_role_record;

typedef struct {
    char operation_result[24];
    char ownership_result[24];
    char live_match_classification[32];
    char reason_code[48];
    char probe_json[MOB_MOR1_MAX_BYTES + 1U];
    size_t probe_json_length;
} mob_remote_result;

typedef struct {
    bool accepted_invocation;
    const char *connection_result;
    const char *target_binding_result;
    const char *host_key_result;
    const char *identity_result;
    const char *operation_result;
    const char *ownership_correlation_result;
    const char *live_match_classification;
    const char *reason_code;
    const char *probe_json;
    size_t probe_json_length;
} mob_parent_result;

typedef enum {
    MOB_CLEANUP_INIT = 0,
    MOB_CLEANUP_RESOURCES_READY = 1,
    MOB_CLEANUP_CHILD_RUNNING = 2,
    MOB_CLEANUP_CLEANING = 3,
    MOB_CLEANUP_DONE = 4,
    MOB_CLEANUP_FAILED = 5
} mob_cleanup_state;

typedef enum {
    MOB_AGENT_REQUEST_REJECT = 0,
    MOB_AGENT_REQUEST_IDENTITIES = 1,
    MOB_AGENT_REQUEST_SIGN = 2
} mob_agent_request_type;

typedef struct {
    mob_agent_request_type type;
    const uint8_t *sign_data;
    size_t sign_data_length;
} mob_agent_request;

typedef enum {
    MOB_PROTECTED_ACCESS_SUCCESS = 0,
    MOB_PROTECTED_ACCESS_NOT_FOUND = 1,
    MOB_PROTECTED_ACCESS_DENIED = 2,
    MOB_PROTECTED_ACCESS_INTERACTION_REQUIRED = 3
} mob_protected_access_outcome;

/* Returns SUCCESS or one exact broker reason code. */
const char *mob_validate_invocation(int argc, const char *const argv[]);

/* Pure mapping used by the separately linked native Keychain adapter. */
const char *mob_protected_access_reason(
    bool identity,
    mob_protected_access_outcome outcome,
    size_t match_count
);

/* Strict canonical target and username validators. */
bool mob_validate_target(
    const char *kind,
    const uint8_t *value,
    size_t value_length,
    char output[MOB_TARGET_MAX_BYTES + 1U]
);
bool mob_validate_username(const uint8_t *value, size_t value_length, char output[MOB_USERNAME_MAX_BYTES + 1U]);
bool mob_validate_internal_path(const char *path);

/* MOBR1 is "MOBR1" followed by tags 1..14, each tag:u8 + len:u32be + value. */
const char *mob_parse_mobr1(
    const uint8_t *input,
    size_t input_length,
    uint64_t now,
    uint32_t current_build,
    mob_role_record *record
);
bool mob_encode_mobr1(
    const mob_role_record *record,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_length
);

/* MOR1 is "MOR1" followed by tags 1..9 in the same canonical TLV form. */
const char *mob_parse_mor1(const uint8_t *input, size_t input_length, mob_remote_result *result);
bool mob_encode_mor1(
    const mob_remote_result *result,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_length
);

bool mob_validate_probe_json(const char *input, size_t input_length);
bool mob_reason_allowed(const char *reason_code);
const char *mob_reason_or_internal(const char *reason_code);

bool mob_serialize_parent_json(
    const mob_parent_result *result,
    char *output,
    size_t output_capacity,
    size_t *output_length
);

bool mob_render_ssh_config(
    const mob_role_record *record,
    const char *identity_path,
    const char *agent_path,
    const char *known_hosts_path,
    char *output,
    size_t output_capacity,
    size_t *output_length
);
bool mob_verify_ssh_effective_config(
    const char *expanded,
    size_t expanded_length,
    const mob_role_record *record,
    const char *identity_path,
    const char *agent_path,
    const char *known_hosts_path
);

bool mob_cleanup_transition(mob_cleanup_state *state, mob_cleanup_state next_state);

/* Parses one unframed SSH-agent payload; only exact identities/sign are accepted. */
bool mob_parse_agent_request(
    const uint8_t *request,
    size_t request_length,
    const uint8_t *exact_public_key,
    size_t exact_public_key_length,
    mob_agent_request *parsed
);

void mob_sha256(const uint8_t *input, size_t input_length, uint8_t output[32]);
bool mob_base64_encode(
    const uint8_t *input,
    size_t input_length,
    char *output,
    size_t output_capacity,
    size_t *output_length
);
bool mob_make_ed25519_key_blob(const uint8_t raw_key[32], uint8_t *output, size_t capacity, size_t *length);
bool mob_make_p256_key_blob(const uint8_t *x963_key, size_t key_length, uint8_t *output, size_t capacity, size_t *length);

#endif
