#include "local_opaque_operation_broker_core.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>

bool mob_native_admin_action_supported(uint32_t action);
bool mob_validate_parent_json(const char *input, size_t input_length);

typedef struct {
    const uint8_t *data;
    size_t length;
    size_t offset;
} mob_binary_cursor;

typedef struct {
    const char *data;
    size_t length;
    size_t offset;
} mob_json_cursor;

typedef struct {
    char *data;
    size_t capacity;
    size_t length;
    bool valid;
} mob_text_writer;

static const char *const mob_reason_codes[] = {
    "SUCCESS",
    "INVALID_INVOCATION",
    "UNKNOWN_ROLE",
    "UNKNOWN_OPERATION",
    "BROKER_INTEGRITY_FAILURE",
    "PROTECTED_RECORD_NOT_FOUND",
    "PROTECTED_RECORD_AMBIGUOUS",
    "PROTECTED_RECORD_ACCESS_DENIED",
    "PROTECTED_RECORD_INTERACTION_REQUIRED",
    "PROTECTED_RECORD_INVALID",
    "RECORD_VERSION_MISMATCH",
    "RECORD_EXPIRED",
    "TARGET_BINDING_REJECTED",
    "HOST_KEY_BINDING_REJECTED",
    "IDENTITY_KEY_NOT_FOUND",
    "IDENTITY_KEY_ACCESS_DENIED",
    "IDENTITY_KEY_INTERACTION_REQUIRED",
    "IDENTITY_BINDING_REJECTED",
    "IDENTITY_AGENT_FAILURE",
    "TEMP_RESOURCE_FAILURE",
    "SSH_LAUNCH_FAILURE",
    "SSH_TIMEOUT",
    "SSH_HOST_KEY_REJECTED",
    "SSH_AUTHENTICATION_FAILED",
    "SSH_TRANSPORT_FAILURE",
    "REMOTE_OUTPUT_INVALID_OR_OVERSIZED",
    "REMOTE_OPERATION_PERMISSION_DENIED",
    "REMOTE_OPERATION_POLICY_REJECTED",
    "REMOTE_OPERATION_FAILED",
    "OWNERSHIP_ZERO_MATCH",
    "OWNERSHIP_MULTIPLE_MATCHES",
    "OWNERSHIP_UNEXPECTED_MATCH",
    "OWNERSHIP_UNKNOWN",
    "INTERRUPTED",
    "CLEANUP_FAILED",
    "INTERNAL_FAIL_CLOSED",
};

static const char *const mob_probe_reason_codes[] = {
    "MATCH",
    "CONNECTION_OR_PROTOCOL_FAILURE",
    "REQUEST_TIMEOUT",
    "HTTP_NON_200",
    "RESPONSE_INVALID_OR_OVERSIZED",
    "CONTRACT_MISMATCH",
    "OTHER_REQUEST_EXCEPTION",
};

static bool mob_string_in_set(const char *value, const char *const *set, size_t count) {
    size_t index;
    if (value == NULL) {
        return false;
    }
    for (index = 0U; index < count; ++index) {
        if (strcmp(value, set[index]) == 0) {
            return true;
        }
    }
    return false;
}

bool mob_reason_allowed(const char *reason_code) {
    return mob_string_in_set(
        reason_code,
        mob_reason_codes,
        sizeof(mob_reason_codes) / sizeof(mob_reason_codes[0])
    );
}

const char *mob_reason_or_internal(const char *reason_code) {
    return mob_reason_allowed(reason_code) ? reason_code : "INTERNAL_FAIL_CLOSED";
}

const char *mob_validate_invocation(int argc, const char *const argv[]) {
    if (argv == NULL || argc != 6 || argv[0] == NULL) {
        return "INVALID_INVOCATION";
    }
    if (argv[1] == NULL || strcmp(argv[1], "run") != 0 ||
        argv[2] == NULL || strcmp(argv[2], "--role") != 0 ||
        argv[4] == NULL || strcmp(argv[4], "--operation") != 0 ||
        argv[3] == NULL || argv[5] == NULL) {
        return "INVALID_INVOCATION";
    }
    if (strcmp(argv[3], MOB_ROLE) != 0) {
        return "UNKNOWN_ROLE";
    }
    if (strcmp(argv[5], MOB_OPERATION) != 0) {
        return "UNKNOWN_OPERATION";
    }
    return "SUCCESS";
}

bool mob_native_admin_action_supported(uint32_t action) {
    return action == 0U || action == 2U;
}

const char *mob_protected_access_reason(
    bool identity,
    mob_protected_access_outcome outcome,
    size_t match_count
) {
    if (outcome == MOB_PROTECTED_ACCESS_NOT_FOUND) {
        return identity ? "IDENTITY_KEY_NOT_FOUND" : "PROTECTED_RECORD_NOT_FOUND";
    }
    if (outcome == MOB_PROTECTED_ACCESS_INTERACTION_REQUIRED) {
        return identity ? "IDENTITY_KEY_INTERACTION_REQUIRED" :
                          "PROTECTED_RECORD_INTERACTION_REQUIRED";
    }
    if (outcome == MOB_PROTECTED_ACCESS_DENIED) {
        return identity ? "IDENTITY_KEY_ACCESS_DENIED" : "PROTECTED_RECORD_ACCESS_DENIED";
    }
    if (outcome != MOB_PROTECTED_ACCESS_SUCCESS) {
        return "INTERNAL_FAIL_CLOSED";
    }
    if (identity) {
        return match_count == 1U ? "SUCCESS" : "IDENTITY_BINDING_REJECTED";
    }
    if (match_count == 0U) {
        return "PROTECTED_RECORD_NOT_FOUND";
    }
    if (match_count != 1U) {
        return "PROTECTED_RECORD_AMBIGUOUS";
    }
    return "SUCCESS";
}

static bool mob_copy_bytes_as_string(
    const uint8_t *input,
    size_t input_length,
    char *output,
    size_t output_capacity
) {
    size_t index;
    if (input == NULL || output == NULL || output_capacity == 0U ||
        input_length == 0U || input_length >= output_capacity) {
        return false;
    }
    for (index = 0U; index < input_length; ++index) {
        if (input[index] == 0U || input[index] > 0x7fU) {
            return false;
        }
    }
    memcpy(output, input, input_length);
    output[input_length] = '\0';
    return true;
}

static bool mob_parse_decimal_octet(const char *start, size_t length, unsigned int *value) {
    size_t index;
    unsigned int parsed = 0U;
    if (start == NULL || value == NULL || length == 0U || length > 3U ||
        (length > 1U && start[0] == '0')) {
        return false;
    }
    for (index = 0U; index < length; ++index) {
        if (start[index] < '0' || start[index] > '9') {
            return false;
        }
        parsed = (parsed * 10U) + (unsigned int)(start[index] - '0');
    }
    if (parsed > 255U) {
        return false;
    }
    *value = parsed;
    return true;
}

static bool mob_is_canonical_ipv4(const char *value) {
    const char *part = value;
    const char *cursor = value;
    unsigned int component = 0U;
    unsigned int count = 0U;
    if (value == NULL || *value == '\0') {
        return false;
    }
    for (;;) {
        if (*cursor == '.' || *cursor == '\0') {
            if (!mob_parse_decimal_octet(part, (size_t)(cursor - part), &component)) {
                return false;
            }
            ++count;
            if (*cursor == '\0') {
                break;
            }
            part = cursor + 1;
        } else if (*cursor < '0' || *cursor > '9') {
            return false;
        }
        ++cursor;
    }
    return count == 4U;
}

static bool mob_parse_ipv6_group(const char *start, size_t length, uint16_t *value) {
    size_t index;
    unsigned int parsed = 0U;
    if (start == NULL || value == NULL || length == 0U || length > 4U ||
        (length > 1U && start[0] == '0')) {
        return false;
    }
    for (index = 0U; index < length; ++index) {
        unsigned int digit;
        const char character = start[index];
        if (character >= '0' && character <= '9') {
            digit = (unsigned int)(character - '0');
        } else if (character >= 'a' && character <= 'f') {
            digit = (unsigned int)(character - 'a') + 10U;
        } else {
            return false;
        }
        parsed = (parsed << 4U) | digit;
    }
    *value = (uint16_t)parsed;
    return true;
}

static bool mob_parse_ipv6_side(
    const char *start,
    size_t length,
    uint16_t groups[8],
    size_t *group_count
) {
    size_t offset = 0U;
    size_t count = 0U;
    if (start == NULL || groups == NULL || group_count == NULL) {
        return false;
    }
    if (length == 0U) {
        *group_count = 0U;
        return true;
    }
    while (offset < length) {
        size_t end = offset;
        if (count == 8U) {
            return false;
        }
        while (end < length && start[end] != ':') {
            ++end;
        }
        if (!mob_parse_ipv6_group(start + offset, end - offset, &groups[count])) {
            return false;
        }
        ++count;
        if (end == length) {
            break;
        }
        offset = end + 1U;
        if (offset == length) {
            return false;
        }
    }
    *group_count = count;
    return true;
}

static bool mob_render_ipv6(const uint16_t groups[8], char *output, size_t capacity) {
    size_t index;
    size_t best_start = 8U;
    size_t best_length = 0U;
    size_t position = 0U;
    if (groups == NULL || output == NULL || capacity < 3U) {
        return false;
    }
    for (index = 0U; index < 8U;) {
        size_t end = index;
        while (end < 8U && groups[end] == 0U) {
            ++end;
        }
        if (end - index >= 2U && end - index > best_length) {
            best_start = index;
            best_length = end - index;
        }
        index = end > index ? end : index + 1U;
    }
    for (index = 0U; index < 8U; ++index) {
        int written;
        if (index == best_start) {
            if (position + 2U >= capacity) {
                return false;
            }
            output[position++] = ':';
            output[position++] = ':';
            index += best_length - 1U;
            continue;
        }
        if (position > 0U && output[position - 1U] != ':') {
            if (position + 1U >= capacity) {
                return false;
            }
            output[position++] = ':';
        }
        written = snprintf(output + position, capacity - position, "%x", (unsigned int)groups[index]);
        if (written <= 0 || (size_t)written >= capacity - position) {
            return false;
        }
        position += (size_t)written;
    }
    output[position] = '\0';
    return true;
}

static bool mob_is_canonical_ipv6(const char *value) {
    const char *compression;
    uint16_t left[8] = {0U};
    uint16_t right[8] = {0U};
    uint16_t groups[8] = {0U};
    size_t left_count = 0U;
    size_t right_count = 0U;
    size_t index;
    char rendered[48];
    if (value == NULL || *value == '\0' || strlen(value) > 45U) {
        return false;
    }
    compression = strstr(value, "::");
    if (compression != NULL && strstr(compression + 2, "::") != NULL) {
        return false;
    }
    if (compression == NULL) {
        if (!mob_parse_ipv6_side(value, strlen(value), groups, &left_count) || left_count != 8U) {
            return false;
        }
    } else {
        const char *right_start = compression + 2;
        if (!mob_parse_ipv6_side(value, (size_t)(compression - value), left, &left_count) ||
            !mob_parse_ipv6_side(right_start, strlen(right_start), right, &right_count) ||
            left_count + right_count >= 8U) {
            return false;
        }
        for (index = 0U; index < left_count; ++index) {
            groups[index] = left[index];
        }
        for (index = 0U; index < right_count; ++index) {
            groups[8U - right_count + index] = right[index];
        }
    }
    if (!mob_render_ipv6(groups, rendered, sizeof(rendered))) {
        return false;
    }
    return strcmp(value, rendered) == 0;
}

static bool mob_is_strict_dns_alabel(const char *value) {
    size_t index;
    size_t label_start = 0U;
    const size_t length = value == NULL ? 0U : strlen(value);
    if (length == 0U || length > MOB_TARGET_MAX_BYTES || value[length - 1U] == '.') {
        return false;
    }
    for (index = 0U; index <= length; ++index) {
        if (index == length || value[index] == '.') {
            const size_t label_length = index - label_start;
            if (label_length == 0U || label_length > 63U ||
                value[label_start] == '-' || value[index - 1U] == '-') {
                return false;
            }
            label_start = index + 1U;
            continue;
        }
        if (!((value[index] >= 'a' && value[index] <= 'z') ||
              (value[index] >= '0' && value[index] <= '9') || value[index] == '-')) {
            return false;
        }
    }
    return true;
}

bool mob_validate_target(
    const char *kind,
    const uint8_t *value,
    size_t value_length,
    char output[MOB_TARGET_MAX_BYTES + 1U]
) {
    char candidate[MOB_TARGET_MAX_BYTES + 1U];
    bool valid;
    if (!mob_copy_bytes_as_string(value, value_length, candidate, sizeof(candidate)) || kind == NULL) {
        return false;
    }
    if (strcmp(kind, "IP") == 0) {
        valid = mob_is_canonical_ipv4(candidate) || mob_is_canonical_ipv6(candidate);
    } else if (strcmp(kind, "DNS") == 0) {
        valid = mob_is_strict_dns_alabel(candidate);
    } else {
        valid = false;
    }
    if (!valid) {
        return false;
    }
    memcpy(output, candidate, value_length + 1U);
    return true;
}

bool mob_validate_username(
    const uint8_t *value,
    size_t value_length,
    char output[MOB_USERNAME_MAX_BYTES + 1U]
) {
    size_t index;
    char candidate[MOB_USERNAME_MAX_BYTES + 1U];
    if (!mob_copy_bytes_as_string(value, value_length, candidate, sizeof(candidate)) ||
        !((candidate[0] >= 'a' && candidate[0] <= 'z') || candidate[0] == '_') ||
        strcmp(candidate, "root") == 0) {
        return false;
    }
    for (index = 1U; index < value_length; ++index) {
        if (!((candidate[index] >= 'a' && candidate[index] <= 'z') ||
              (candidate[index] >= '0' && candidate[index] <= '9') ||
              candidate[index] == '_' || candidate[index] == '-')) {
            return false;
        }
    }
    memcpy(output, candidate, value_length + 1U);
    return true;
}

bool mob_validate_internal_path(const char *path) {
    size_t index;
    size_t component_start;
    const size_t length = path == NULL ? 0U : strlen(path);
    if (length < 2U || length > MOB_PATH_MAX_BYTES || path[0] != '/') {
        return false;
    }
    component_start = 1U;
    for (index = 1U; index <= length; ++index) {
        if (index == length || path[index] == '/') {
            const size_t component_length = index - component_start;
            if (component_length == 0U ||
                (component_length == 1U && path[component_start] == '.') ||
                (component_length == 2U && path[component_start] == '.' && path[component_start + 1U] == '.')) {
                return false;
            }
            component_start = index + 1U;
            continue;
        }
        if (!((path[index] >= 'A' && path[index] <= 'Z') ||
              (path[index] >= 'a' && path[index] <= 'z') ||
              (path[index] >= '0' && path[index] <= '9') ||
              path[index] == '_' || path[index] == '-' || path[index] == '.')) {
            return false;
        }
    }
    return true;
}

static uint32_t mob_read_u32(const uint8_t *value) {
    return ((uint32_t)value[0] << 24U) |
           ((uint32_t)value[1] << 16U) |
           ((uint32_t)value[2] << 8U) |
           (uint32_t)value[3];
}

static uint64_t mob_read_u64(const uint8_t *value) {
    uint64_t output = 0U;
    size_t index;
    for (index = 0U; index < 8U; ++index) {
        output = (output << 8U) | (uint64_t)value[index];
    }
    return output;
}

static void mob_write_u32(uint8_t output[4], uint32_t value) {
    output[0] = (uint8_t)(value >> 24U);
    output[1] = (uint8_t)(value >> 16U);
    output[2] = (uint8_t)(value >> 8U);
    output[3] = (uint8_t)value;
}

static void mob_write_u64(uint8_t output[8], uint64_t value) {
    size_t index;
    for (index = 0U; index < 8U; ++index) {
        output[7U - index] = (uint8_t)(value >> (index * 8U));
    }
}

static bool mob_tlv_read(
    mob_binary_cursor *cursor,
    uint8_t expected_tag,
    const uint8_t **value,
    size_t *value_length
) {
    uint32_t length;
    if (cursor == NULL || value == NULL || value_length == NULL ||
        cursor->offset > cursor->length || cursor->length - cursor->offset < 5U ||
        cursor->data[cursor->offset] != expected_tag) {
        return false;
    }
    length = mob_read_u32(cursor->data + cursor->offset + 1U);
    cursor->offset += 5U;
    if ((size_t)length > cursor->length - cursor->offset) {
        return false;
    }
    *value = cursor->data + cursor->offset;
    *value_length = (size_t)length;
    cursor->offset += (size_t)length;
    return true;
}

static bool mob_tlv_write(
    uint8_t *output,
    size_t capacity,
    size_t *offset,
    uint8_t tag,
    const uint8_t *value,
    size_t value_length
) {
    if (output == NULL || offset == NULL || value == NULL || value_length > UINT32_MAX ||
        *offset > capacity || capacity - *offset < 5U ||
        value_length > capacity - *offset - 5U) {
        return false;
    }
    output[*offset] = tag;
    mob_write_u32(output + *offset + 1U, (uint32_t)value_length);
    memcpy(output + *offset + 5U, value, value_length);
    *offset += 5U + value_length;
    return true;
}

static bool mob_value_is(const uint8_t *value, size_t value_length, const char *expected) {
    const size_t expected_length = expected == NULL ? 0U : strlen(expected);
    return value != NULL && expected != NULL && value_length == expected_length &&
           memcmp(value, expected, expected_length) == 0;
}

const char *mob_parse_mobr1(
    const uint8_t *input,
    size_t input_length,
    uint64_t now,
    uint32_t current_build,
    mob_role_record *record
) {
    mob_binary_cursor cursor;
    mob_role_record parsed;
    const uint8_t *value;
    size_t value_length;
    if (input == NULL || record == NULL || input_length > MOB_MOBR1_MAX_BYTES ||
        input_length < 5U || memcmp(input, "MOBR1", 5U) != 0) {
        return "PROTECTED_RECORD_INVALID";
    }
    memset(&parsed, 0, sizeof(parsed));
    cursor.data = input;
    cursor.length = input_length;
    cursor.offset = 5U;

    if (!mob_tlv_read(&cursor, 1U, &value, &value_length) || value_length != 4U) {
        return "PROTECTED_RECORD_INVALID";
    }
    parsed.version = mob_read_u32(value);
    if (parsed.version != MOB_RECORD_VERSION) {
        return "RECORD_VERSION_MISMATCH";
    }
    if (!mob_tlv_read(&cursor, 2U, &value, &value_length) || !mob_value_is(value, value_length, MOB_ROLE) ||
        !mob_copy_bytes_as_string(value, value_length, parsed.role, sizeof(parsed.role))) {
        return "PROTECTED_RECORD_INVALID";
    }
    if (!mob_tlv_read(&cursor, 3U, &value, &value_length) || !mob_value_is(value, value_length, MOB_OPERATION) ||
        !mob_copy_bytes_as_string(value, value_length, parsed.operation, sizeof(parsed.operation))) {
        return "PROTECTED_RECORD_INVALID";
    }
    if (!mob_tlv_read(&cursor, 4U, &value, &value_length) ||
        !mob_copy_bytes_as_string(value, value_length, parsed.target_kind, sizeof(parsed.target_kind)) ||
        (strcmp(parsed.target_kind, "IP") != 0 && strcmp(parsed.target_kind, "DNS") != 0)) {
        return "TARGET_BINDING_REJECTED";
    }
    if (!mob_tlv_read(&cursor, 5U, &value, &value_length) ||
        !mob_validate_target(parsed.target_kind, value, value_length, parsed.target)) {
        return "TARGET_BINDING_REJECTED";
    }
    if (!mob_tlv_read(&cursor, 6U, &value, &value_length) || value_length != 2U) {
        return "TARGET_BINDING_REJECTED";
    }
    parsed.port = (uint16_t)(((uint16_t)value[0] << 8U) | (uint16_t)value[1]);
    if (parsed.port == 0U) {
        return "TARGET_BINDING_REJECTED";
    }
    if (!mob_tlv_read(&cursor, 7U, &value, &value_length) ||
        !mob_validate_username(value, value_length, parsed.username)) {
        return "TARGET_BINDING_REJECTED";
    }
    if (!mob_tlv_read(&cursor, 8U, &value, &value_length) ||
        !mob_value_is(value, value_length, MOB_HOST_KEY_ALGORITHM) ||
        !mob_copy_bytes_as_string(value, value_length, parsed.host_key_algorithm, sizeof(parsed.host_key_algorithm))) {
        return "HOST_KEY_BINDING_REJECTED";
    }
    if (!mob_tlv_read(&cursor, 9U, &value, &value_length) || value_length != sizeof(parsed.host_key)) {
        return "HOST_KEY_BINDING_REJECTED";
    }
    memcpy(parsed.host_key, value, sizeof(parsed.host_key));
    if (!mob_tlv_read(&cursor, 10U, &value, &value_length) || value_length == 0U ||
        value_length > sizeof(parsed.persistent_key_ref)) {
        return "PROTECTED_RECORD_INVALID";
    }
    memcpy(parsed.persistent_key_ref, value, value_length);
    parsed.persistent_key_ref_length = value_length;
    if (!mob_tlv_read(&cursor, 11U, &value, &value_length) || value_length != sizeof(parsed.identity_sha256)) {
        return "IDENTITY_BINDING_REJECTED";
    }
    memcpy(parsed.identity_sha256, value, sizeof(parsed.identity_sha256));
    if (!mob_tlv_read(&cursor, 12U, &value, &value_length) ||
        !mob_value_is(value, value_length, MOB_COMMAND_PROFILE) ||
        !mob_copy_bytes_as_string(value, value_length, parsed.command_profile, sizeof(parsed.command_profile))) {
        return "REMOTE_OPERATION_POLICY_REJECTED";
    }
    if (!mob_tlv_read(&cursor, 13U, &value, &value_length) || value_length != 8U) {
        return "PROTECTED_RECORD_INVALID";
    }
    parsed.expires_at = mob_read_u64(value);
    if (parsed.expires_at <= now) {
        return "RECORD_EXPIRED";
    }
    if (!mob_tlv_read(&cursor, 14U, &value, &value_length) || value_length != 4U) {
        return "PROTECTED_RECORD_INVALID";
    }
    parsed.minimum_build = mob_read_u32(value);
    if (parsed.minimum_build == 0U || parsed.minimum_build > current_build) {
        return "RECORD_VERSION_MISMATCH";
    }
    if (cursor.offset != cursor.length) {
        return "PROTECTED_RECORD_INVALID";
    }
    *record = parsed;
    return "SUCCESS";
}

bool mob_encode_mobr1(
    const mob_role_record *record,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_length
) {
    size_t offset = 0U;
    uint8_t integer[8];
    char target[MOB_TARGET_MAX_BYTES + 1U];
    char username[MOB_USERNAME_MAX_BYTES + 1U];
    if (record == NULL || output == NULL || output_length == NULL || output_capacity < 5U ||
        record->version != MOB_RECORD_VERSION || strcmp(record->role, MOB_ROLE) != 0 ||
        strcmp(record->operation, MOB_OPERATION) != 0 ||
        !mob_validate_target(record->target_kind, (const uint8_t *)record->target, strlen(record->target), target) ||
        !mob_validate_username((const uint8_t *)record->username, strlen(record->username), username) ||
        record->port == 0U || strcmp(record->host_key_algorithm, MOB_HOST_KEY_ALGORITHM) != 0 ||
        record->persistent_key_ref_length == 0U ||
        record->persistent_key_ref_length > MOB_PERSISTENT_REF_MAX_BYTES ||
        strcmp(record->command_profile, MOB_COMMAND_PROFILE) != 0 ||
        record->expires_at == 0U || record->minimum_build == 0U) {
        return false;
    }
    memcpy(output, "MOBR1", 5U);
    offset = 5U;
    mob_write_u32(integer, record->version);
    if (!mob_tlv_write(output, output_capacity, &offset, 1U, integer, 4U) ||
        !mob_tlv_write(output, output_capacity, &offset, 2U, (const uint8_t *)record->role, strlen(record->role)) ||
        !mob_tlv_write(output, output_capacity, &offset, 3U, (const uint8_t *)record->operation, strlen(record->operation)) ||
        !mob_tlv_write(output, output_capacity, &offset, 4U, (const uint8_t *)record->target_kind, strlen(record->target_kind)) ||
        !mob_tlv_write(output, output_capacity, &offset, 5U, (const uint8_t *)record->target, strlen(record->target))) {
        return false;
    }
    integer[0] = (uint8_t)(record->port >> 8U);
    integer[1] = (uint8_t)record->port;
    if (!mob_tlv_write(output, output_capacity, &offset, 6U, integer, 2U) ||
        !mob_tlv_write(output, output_capacity, &offset, 7U, (const uint8_t *)record->username, strlen(record->username)) ||
        !mob_tlv_write(output, output_capacity, &offset, 8U, (const uint8_t *)record->host_key_algorithm, strlen(record->host_key_algorithm)) ||
        !mob_tlv_write(output, output_capacity, &offset, 9U, record->host_key, sizeof(record->host_key)) ||
        !mob_tlv_write(output, output_capacity, &offset, 10U, record->persistent_key_ref, record->persistent_key_ref_length) ||
        !mob_tlv_write(output, output_capacity, &offset, 11U, record->identity_sha256, sizeof(record->identity_sha256)) ||
        !mob_tlv_write(output, output_capacity, &offset, 12U, (const uint8_t *)record->command_profile, strlen(record->command_profile))) {
        return false;
    }
    mob_write_u64(integer, record->expires_at);
    if (!mob_tlv_write(output, output_capacity, &offset, 13U, integer, 8U)) {
        return false;
    }
    mob_write_u32(integer, record->minimum_build);
    if (!mob_tlv_write(output, output_capacity, &offset, 14U, integer, 4U) || offset > MOB_MOBR1_MAX_BYTES) {
        return false;
    }
    *output_length = offset;
    return true;
}

static bool mob_json_expect(mob_json_cursor *cursor, const char *literal) {
    const size_t literal_length = literal == NULL ? 0U : strlen(literal);
    if (cursor == NULL || literal == NULL || cursor->offset > cursor->length ||
        literal_length > cursor->length - cursor->offset ||
        memcmp(cursor->data + cursor->offset, literal, literal_length) != 0) {
        return false;
    }
    cursor->offset += literal_length;
    return true;
}

static bool mob_json_uint(mob_json_cursor *cursor, unsigned int *value) {
    unsigned long parsed = 0UL;
    size_t digits = 0U;
    if (cursor == NULL || value == NULL || cursor->offset >= cursor->length ||
        cursor->data[cursor->offset] < '0' || cursor->data[cursor->offset] > '9') {
        return false;
    }
    if (cursor->data[cursor->offset] == '0' && cursor->offset + 1U < cursor->length &&
        cursor->data[cursor->offset + 1U] >= '0' && cursor->data[cursor->offset + 1U] <= '9') {
        return false;
    }
    while (cursor->offset < cursor->length &&
           cursor->data[cursor->offset] >= '0' && cursor->data[cursor->offset] <= '9') {
        const unsigned long digit = (unsigned long)(cursor->data[cursor->offset] - '0');
        if (parsed > (ULONG_MAX - digit) / 10UL) {
            return false;
        }
        parsed = (parsed * 10UL) + digit;
        if (parsed > UINT_MAX) {
            return false;
        }
        ++cursor->offset;
        ++digits;
    }
    if (digits == 0U) {
        return false;
    }
    *value = (unsigned int)parsed;
    return true;
}

static bool mob_json_string(mob_json_cursor *cursor, char *output, size_t capacity) {
    size_t length = 0U;
    if (cursor == NULL || output == NULL || capacity == 0U || !mob_json_expect(cursor, "\"")) {
        return false;
    }
    while (cursor->offset < cursor->length && cursor->data[cursor->offset] != '"') {
        const unsigned char character = (unsigned char)cursor->data[cursor->offset];
        if (character < 0x20U || character > 0x7eU || character == '\\' || length + 1U >= capacity) {
            return false;
        }
        output[length++] = (char)character;
        ++cursor->offset;
    }
    if (!mob_json_expect(cursor, "\"")) {
        return false;
    }
    output[length] = '\0';
    return true;
}

bool mob_validate_probe_json(const char *input, size_t input_length) {
    mob_json_cursor cursor;
    unsigned int candidate_count;
    unsigned int overview_count;
    unsigned int full_count;
    unsigned int computed_overview = 0U;
    unsigned int computed_full = 0U;
    unsigned int record_index;
    if (input == NULL || input_length == 0U || input_length > MOB_MOR1_MAX_BYTES ||
        memchr(input, '\0', input_length) != NULL) {
        return false;
    }
    cursor.data = input;
    cursor.length = input_length;
    cursor.offset = 0U;
    if (!mob_json_expect(&cursor, "{\"schemaVersion\":\"") ||
        !mob_json_expect(&cursor, MOB_PROBE_SCHEMA_VERSION) ||
        !mob_json_expect(&cursor, "\",\"candidateCount\":") ||
        !mob_json_uint(&cursor, &candidate_count) || candidate_count > MOB_PROBE_MAX_RECORDS ||
        !mob_json_expect(&cursor, ",\"overviewHttp200MatchCount\":") ||
        !mob_json_uint(&cursor, &overview_count) ||
        !mob_json_expect(&cursor, ",\"fullContractMatchCount\":") ||
        !mob_json_uint(&cursor, &full_count) ||
        !mob_json_expect(&cursor, ",\"records\":[")) {
        return false;
    }
    for (record_index = 1U; record_index <= candidate_count; ++record_index) {
        unsigned int attempt_index;
        unsigned int http_status = 0U;
        bool status_is_null = false;
        char result[16];
        char stage[16];
        char reason[48];
        if (record_index > 1U && !mob_json_expect(&cursor, ",")) {
            return false;
        }
        if (!mob_json_expect(&cursor, "{\"attemptIndex\":") ||
            !mob_json_uint(&cursor, &attempt_index) || attempt_index != record_index ||
            !mob_json_expect(&cursor, ",\"result\":") ||
            !mob_json_string(&cursor, result, sizeof(result)) ||
            !mob_json_expect(&cursor, ",\"failureStage\":") ||
            !mob_json_string(&cursor, stage, sizeof(stage)) ||
            !mob_json_expect(&cursor, ",\"reasonCode\":") ||
            !mob_json_string(&cursor, reason, sizeof(reason)) ||
            !mob_json_expect(&cursor, ",\"httpStatus\":")) {
            return false;
        }
        if (mob_json_expect(&cursor, "null")) {
            status_is_null = true;
        } else if (!mob_json_uint(&cursor, &http_status) || http_status < 100U || http_status > 599U) {
            return false;
        }
        if (!mob_json_expect(&cursor, "}")) {
            return false;
        }
        if (!mob_string_in_set(
                reason,
                mob_probe_reason_codes,
                sizeof(mob_probe_reason_codes) / sizeof(mob_probe_reason_codes[0])) ||
            !mob_string_in_set(result, (const char *const[]){"MATCH", "NO_MATCH"}, 2U) ||
            !mob_string_in_set(stage, (const char *const[]){"CONNECT", "OVERVIEW", "LATENCY", "CONTRACT", "NONE"}, 5U)) {
            return false;
        }
        if (strcmp(result, "MATCH") == 0) {
            if (strcmp(stage, "NONE") != 0 || strcmp(reason, "MATCH") != 0 ||
                status_is_null || http_status != 200U) {
                return false;
            }
            ++computed_overview;
            ++computed_full;
        } else {
            if (strcmp(stage, "NONE") == 0 || strcmp(reason, "MATCH") == 0) {
                return false;
            }
            if (strcmp(stage, "LATENCY") == 0 || strcmp(stage, "CONTRACT") == 0 ||
                (!status_is_null && http_status == 200U)) {
                ++computed_overview;
            }
        }
    }
    return mob_json_expect(&cursor, "]}") && cursor.offset == cursor.length &&
           overview_count == computed_overview && full_count == computed_full &&
           full_count <= overview_count && overview_count <= candidate_count;
}

static bool mob_copy_tlv_string(
    mob_binary_cursor *cursor,
    uint8_t tag,
    char *output,
    size_t capacity
) {
    const uint8_t *value;
    size_t value_length;
    return mob_tlv_read(cursor, tag, &value, &value_length) &&
           mob_copy_bytes_as_string(value, value_length, output, capacity);
}

static bool mob_remote_result_semantics_valid(const mob_remote_result *result) {
    const bool has_probe = result != NULL && result->probe_json_length > 0U;
    if (result == NULL) {
        return false;
    }
#define MOB_REMOTE_IS(operation_value, ownership_value, classification_value, reason_value) \
    (strcmp(result->operation_result, operation_value) == 0 && \
     strcmp(result->ownership_result, ownership_value) == 0 && \
     strcmp(result->live_match_classification, classification_value) == 0 && \
     strcmp(result->reason_code, reason_value) == 0)
    if (has_probe &&
        (MOB_REMOTE_IS("SUCCESS", "MATCH", "UNIQUE_EXPECTED_MATCH", "SUCCESS") ||
         MOB_REMOTE_IS("SUCCESS", "ZERO_MATCH", "ZERO_MATCH", "OWNERSHIP_ZERO_MATCH") ||
         MOB_REMOTE_IS("SUCCESS", "MULTIPLE_MATCHES", "MULTIPLE_MATCHES", "OWNERSHIP_MULTIPLE_MATCHES") ||
         MOB_REMOTE_IS("SUCCESS", "UNEXPECTED_MATCH", "UNIQUE_UNEXPECTED_MATCH", "OWNERSHIP_UNEXPECTED_MATCH"))) {
        return true;
    }
    if (MOB_REMOTE_IS("FAILED", "UNKNOWN", "UNKNOWN", "OWNERSHIP_UNKNOWN")) {
        return true;
    }
    if (!has_probe &&
        (MOB_REMOTE_IS("BLOCKED", "UNKNOWN", "UNKNOWN", "REMOTE_OPERATION_PERMISSION_DENIED") ||
         MOB_REMOTE_IS("BLOCKED", "NOT_RUN", "NOT_RUN", "REMOTE_OPERATION_POLICY_REJECTED") ||
         MOB_REMOTE_IS("FAILED", "UNKNOWN", "UNKNOWN", "REMOTE_OUTPUT_INVALID_OR_OVERSIZED") ||
         MOB_REMOTE_IS("FAILED", "UNKNOWN", "UNKNOWN", "REMOTE_OPERATION_FAILED") ||
         MOB_REMOTE_IS("FAILED", "UNKNOWN", "UNKNOWN", "INTERNAL_FAIL_CLOSED"))) {
        return true;
    }
#undef MOB_REMOTE_IS
    return false;
}

const char *mob_parse_mor1(const uint8_t *input, size_t input_length, mob_remote_result *result) {
    mob_binary_cursor cursor;
    mob_remote_result parsed;
    const uint8_t *value;
    size_t value_length;
    uint32_t version;
    if (input == NULL || result == NULL || input_length < 4U || input_length > MOB_MOR1_MAX_BYTES ||
        memcmp(input, "MOR1", 4U) != 0) {
        return "REMOTE_OUTPUT_INVALID_OR_OVERSIZED";
    }
    memset(&parsed, 0, sizeof(parsed));
    cursor.data = input;
    cursor.length = input_length;
    cursor.offset = 4U;
    if (!mob_tlv_read(&cursor, 1U, &value, &value_length) || value_length != 4U) {
        return "REMOTE_OUTPUT_INVALID_OR_OVERSIZED";
    }
    version = mob_read_u32(value);
    if (version != MOB_RECORD_VERSION) {
        return "REMOTE_OUTPUT_INVALID_OR_OVERSIZED";
    }
    if (!mob_copy_tlv_string(&cursor, 2U, parsed.operation_result, sizeof(parsed.operation_result)) ||
        !mob_string_in_set(parsed.operation_result, (const char *const[]){"SUCCESS", "FAILED", "BLOCKED", "NOT_RUN"}, 4U) ||
        !mob_copy_tlv_string(&cursor, 3U, parsed.ownership_result, sizeof(parsed.ownership_result)) ||
        !mob_string_in_set(parsed.ownership_result, (const char *const[]){"MATCH", "ZERO_MATCH", "MULTIPLE_MATCHES", "UNEXPECTED_MATCH", "UNKNOWN", "NOT_RUN"}, 6U) ||
        !mob_copy_tlv_string(&cursor, 4U, parsed.live_match_classification, sizeof(parsed.live_match_classification)) ||
        !mob_string_in_set(parsed.live_match_classification, (const char *const[]){"ZERO_MATCH", "UNIQUE_EXPECTED_MATCH", "UNIQUE_UNEXPECTED_MATCH", "MULTIPLE_MATCHES", "UNKNOWN", "NOT_RUN"}, 6U) ||
        !mob_copy_tlv_string(&cursor, 5U, parsed.reason_code, sizeof(parsed.reason_code)) ||
        !mob_reason_allowed(parsed.reason_code)) {
        return "REMOTE_OUTPUT_INVALID_OR_OVERSIZED";
    }
    if (!mob_tlv_read(&cursor, 6U, &value, &value_length) || !mob_value_is(value, value_length, "NONE") ||
        !mob_tlv_read(&cursor, 7U, &value, &value_length) || value_length != 4U || mob_read_u32(value) != 0U ||
        !mob_tlv_read(&cursor, 8U, &value, &value_length) || !mob_value_is(value, value_length, "NONE") ||
        !mob_tlv_read(&cursor, 9U, &value, &value_length) || value_length > MOB_MOR1_MAX_BYTES) {
        return "REMOTE_OUTPUT_INVALID_OR_OVERSIZED";
    }
    if (value_length > 0U) {
        if (!mob_validate_probe_json((const char *)value, value_length)) {
            return "REMOTE_OUTPUT_INVALID_OR_OVERSIZED";
        }
        memcpy(parsed.probe_json, value, value_length);
    }
    parsed.probe_json[value_length] = '\0';
    parsed.probe_json_length = value_length;
    if (cursor.offset != cursor.length || !mob_remote_result_semantics_valid(&parsed)) {
        return "REMOTE_OUTPUT_INVALID_OR_OVERSIZED";
    }
    *result = parsed;
    return "SUCCESS";
}

bool mob_encode_mor1(
    const mob_remote_result *result,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_length
) {
    uint8_t integer[4];
    size_t offset = 4U;
    if (result == NULL || output == NULL || output_length == NULL || output_capacity < 4U ||
        !mob_string_in_set(result->operation_result, (const char *const[]){"SUCCESS", "FAILED", "BLOCKED", "NOT_RUN"}, 4U) ||
        !mob_string_in_set(result->ownership_result, (const char *const[]){"MATCH", "ZERO_MATCH", "MULTIPLE_MATCHES", "UNEXPECTED_MATCH", "UNKNOWN", "NOT_RUN"}, 6U) ||
        !mob_string_in_set(result->live_match_classification, (const char *const[]){"ZERO_MATCH", "UNIQUE_EXPECTED_MATCH", "UNIQUE_UNEXPECTED_MATCH", "MULTIPLE_MATCHES", "UNKNOWN", "NOT_RUN"}, 6U) ||
        !mob_reason_allowed(result->reason_code) || result->probe_json_length > MOB_MOR1_MAX_BYTES ||
        !mob_remote_result_semantics_valid(result) ||
        (result->probe_json_length > 0U && !mob_validate_probe_json(result->probe_json, result->probe_json_length))) {
        return false;
    }
    memcpy(output, "MOR1", 4U);
    mob_write_u32(integer, MOB_RECORD_VERSION);
    if (!mob_tlv_write(output, output_capacity, &offset, 1U, integer, sizeof(integer)) ||
        !mob_tlv_write(output, output_capacity, &offset, 2U, (const uint8_t *)result->operation_result, strlen(result->operation_result)) ||
        !mob_tlv_write(output, output_capacity, &offset, 3U, (const uint8_t *)result->ownership_result, strlen(result->ownership_result)) ||
        !mob_tlv_write(output, output_capacity, &offset, 4U, (const uint8_t *)result->live_match_classification, strlen(result->live_match_classification)) ||
        !mob_tlv_write(output, output_capacity, &offset, 5U, (const uint8_t *)result->reason_code, strlen(result->reason_code)) ||
        !mob_tlv_write(output, output_capacity, &offset, 6U, (const uint8_t *)"NONE", 4U)) {
        return false;
    }
    memset(integer, 0, sizeof(integer));
    if (!mob_tlv_write(output, output_capacity, &offset, 7U, integer, sizeof(integer)) ||
        !mob_tlv_write(output, output_capacity, &offset, 8U, (const uint8_t *)"NONE", 4U) ||
        !mob_tlv_write(output, output_capacity, &offset, 9U, (const uint8_t *)result->probe_json, result->probe_json_length) ||
        offset > MOB_MOR1_MAX_BYTES) {
        return false;
    }
    *output_length = offset;
    return true;
}

static void mob_writer_append(mob_text_writer *writer, const char *value) {
    const size_t value_length = value == NULL ? 0U : strlen(value);
    if (writer == NULL || !writer->valid || value == NULL || writer->length > writer->capacity ||
        value_length >= writer->capacity - writer->length) {
        if (writer != NULL) {
            writer->valid = false;
        }
        return;
    }
    memcpy(writer->data + writer->length, value, value_length);
    writer->length += value_length;
    writer->data[writer->length] = '\0';
}

static void mob_writer_append_bytes(mob_text_writer *writer, const char *value, size_t value_length) {
    if (writer == NULL || !writer->valid || value == NULL || writer->length > writer->capacity ||
        value_length >= writer->capacity - writer->length) {
        if (writer != NULL) {
            writer->valid = false;
        }
        return;
    }
    memcpy(writer->data + writer->length, value, value_length);
    writer->length += value_length;
    writer->data[writer->length] = '\0';
}

static bool mob_parent_value_allowed(const char *field, const char *value) {
    if (strcmp(field, "connection") == 0) {
        return mob_string_in_set(value, (const char *const[]){"SUCCESS", "FAILED", "BLOCKED", "NOT_RUN"}, 4U);
    }
    if (strcmp(field, "binding") == 0) {
        return mob_string_in_set(value, (const char *const[]){"MATCH", "REJECTED", "UNKNOWN", "NOT_RUN"}, 4U);
    }
    if (strcmp(field, "operation") == 0) {
        return mob_string_in_set(value, (const char *const[]){"SUCCESS", "FAILED", "BLOCKED", "NOT_RUN"}, 4U);
    }
    if (strcmp(field, "ownership") == 0) {
        return mob_string_in_set(value, (const char *const[]){"MATCH", "ZERO_MATCH", "MULTIPLE_MATCHES", "UNEXPECTED_MATCH", "UNKNOWN", "NOT_RUN"}, 6U);
    }
    if (strcmp(field, "classification") == 0) {
        return mob_string_in_set(value, (const char *const[]){"ZERO_MATCH", "UNIQUE_EXPECTED_MATCH", "UNIQUE_UNEXPECTED_MATCH", "MULTIPLE_MATCHES", "UNKNOWN", "NOT_RUN"}, 6U);
    }
    return false;
}

static void mob_writer_json_string(mob_text_writer *writer, const char *value) {
    mob_writer_append(writer, "\"");
    mob_writer_append(writer, value);
    mob_writer_append(writer, "\"");
}

bool mob_serialize_parent_json(
    const mob_parent_result *result,
    char *output,
    size_t output_capacity,
    size_t *output_length
) {
    mob_text_writer writer;
    if (result == NULL || output == NULL || output_length == NULL || output_capacity == 0U ||
        !mob_parent_value_allowed("connection", result->connection_result) ||
        !mob_parent_value_allowed("binding", result->target_binding_result) ||
        !mob_parent_value_allowed("binding", result->host_key_result) ||
        !mob_parent_value_allowed("binding", result->identity_result) ||
        !mob_parent_value_allowed("operation", result->operation_result) ||
        !mob_parent_value_allowed("ownership", result->ownership_correlation_result) ||
        !mob_parent_value_allowed("classification", result->live_match_classification) ||
        !mob_reason_allowed(result->reason_code) ||
        (result->probe_json_length > 0U &&
         (result->probe_json == NULL || !mob_validate_probe_json(result->probe_json, result->probe_json_length)))) {
        return false;
    }
    writer.data = output;
    writer.capacity = output_capacity;
    writer.length = 0U;
    writer.valid = true;
    output[0] = '\0';
    mob_writer_append(&writer, "{\"schemaVersion\":\"");
    mob_writer_append(&writer, MOB_SCHEMA_VERSION);
    mob_writer_append(&writer, "\",\"role\":");
    if (result->accepted_invocation) {
        mob_writer_json_string(&writer, MOB_ROLE);
    } else {
        mob_writer_append(&writer, "null");
    }
    mob_writer_append(&writer, ",\"operation\":");
    if (result->accepted_invocation) {
        mob_writer_json_string(&writer, MOB_OPERATION);
    } else {
        mob_writer_append(&writer, "null");
    }
#define MOB_APPEND_RESULT_FIELD(name_literal, value_expression) \
    do { \
        mob_writer_append(&writer, ",\"" name_literal "\":"); \
        mob_writer_json_string(&writer, (value_expression)); \
    } while (0)
    MOB_APPEND_RESULT_FIELD("connectionResult", result->connection_result);
    MOB_APPEND_RESULT_FIELD("targetBindingResult", result->target_binding_result);
    MOB_APPEND_RESULT_FIELD("hostKeyResult", result->host_key_result);
    MOB_APPEND_RESULT_FIELD("identityResult", result->identity_result);
    MOB_APPEND_RESULT_FIELD("operationResult", result->operation_result);
    MOB_APPEND_RESULT_FIELD("ownershipCorrelationResult", result->ownership_correlation_result);
    MOB_APPEND_RESULT_FIELD("liveMatchClassification", result->live_match_classification);
    MOB_APPEND_RESULT_FIELD("productionWrite", "NONE");
    mob_writer_append(&writer, ",\"serviceActions\":0");
    MOB_APPEND_RESULT_FIELD("permissionDelta", "NONE");
    MOB_APPEND_RESULT_FIELD("reasonCode", result->reason_code);
#undef MOB_APPEND_RESULT_FIELD
    mob_writer_append(&writer, ",\"probeDiagnostic\":");
    if (result->probe_json_length == 0U) {
        mob_writer_append(&writer, "null");
    } else {
        mob_writer_append_bytes(&writer, result->probe_json, result->probe_json_length);
    }
    mob_writer_append(&writer, "}");
    if (!writer.valid) {
        if (output_capacity > 0U) {
            output[0] = '\0';
        }
        return false;
    }
    *output_length = writer.length;
    return true;
}

bool mob_validate_parent_json(const char *input, size_t input_length) {
    mob_json_cursor cursor;
    char connection[24];
    char target_binding[16];
    char host_key[16];
    char identity[16];
    char operation[24];
    char ownership[24];
    char classification[32];
    char reason[48];
    unsigned int service_actions;
    bool accepted_invocation;
    if (input == NULL || input_length == 0U || input_length > 65536U ||
        memchr(input, '\0', input_length) != NULL) {
        return false;
    }
    cursor.data = input;
    cursor.length = input_length;
    cursor.offset = 0U;
    if (!mob_json_expect(&cursor, "{\"schemaVersion\":\"") ||
        !mob_json_expect(&cursor, MOB_SCHEMA_VERSION) ||
        !mob_json_expect(&cursor, "\",\"role\":")) {
        return false;
    }
    if (mob_json_expect(&cursor, "null")) {
        accepted_invocation = false;
    } else {
        accepted_invocation = mob_json_expect(&cursor, "\"") &&
            mob_json_expect(&cursor, MOB_ROLE) && mob_json_expect(&cursor, "\"");
        if (!accepted_invocation) {
            return false;
        }
    }
    if (!mob_json_expect(&cursor, ",\"operation\":")) {
        return false;
    }
    if (accepted_invocation) {
        if (!mob_json_expect(&cursor, "\"") ||
            !mob_json_expect(&cursor, MOB_OPERATION) ||
            !mob_json_expect(&cursor, "\"")) {
            return false;
        }
    } else if (!mob_json_expect(&cursor, "null")) {
        return false;
    }
    if (!mob_json_expect(&cursor, ",\"connectionResult\":") ||
        !mob_json_string(&cursor, connection, sizeof(connection)) ||
        !mob_json_expect(&cursor, ",\"targetBindingResult\":") ||
        !mob_json_string(&cursor, target_binding, sizeof(target_binding)) ||
        !mob_json_expect(&cursor, ",\"hostKeyResult\":") ||
        !mob_json_string(&cursor, host_key, sizeof(host_key)) ||
        !mob_json_expect(&cursor, ",\"identityResult\":") ||
        !mob_json_string(&cursor, identity, sizeof(identity)) ||
        !mob_json_expect(&cursor, ",\"operationResult\":") ||
        !mob_json_string(&cursor, operation, sizeof(operation)) ||
        !mob_json_expect(&cursor, ",\"ownershipCorrelationResult\":") ||
        !mob_json_string(&cursor, ownership, sizeof(ownership)) ||
        !mob_json_expect(&cursor, ",\"liveMatchClassification\":") ||
        !mob_json_string(&cursor, classification, sizeof(classification)) ||
        !mob_json_expect(&cursor, ",\"productionWrite\":\"NONE\"") ||
        !mob_json_expect(&cursor, ",\"serviceActions\":") ||
        !mob_json_uint(&cursor, &service_actions) || service_actions != 0U ||
        !mob_json_expect(&cursor, ",\"permissionDelta\":\"NONE\"") ||
        !mob_json_expect(&cursor, ",\"reasonCode\":") ||
        !mob_json_string(&cursor, reason, sizeof(reason)) ||
        !mob_json_expect(&cursor, ",\"probeDiagnostic\":")) {
        return false;
    }
    if (!mob_parent_value_allowed("connection", connection) ||
        !mob_parent_value_allowed("binding", target_binding) ||
        !mob_parent_value_allowed("binding", host_key) ||
        !mob_parent_value_allowed("binding", identity) ||
        !mob_parent_value_allowed("operation", operation) ||
        !mob_parent_value_allowed("ownership", ownership) ||
        !mob_parent_value_allowed("classification", classification) ||
        !mob_reason_allowed(reason)) {
        return false;
    }
    if (mob_json_expect(&cursor, "null")) {
        return mob_json_expect(&cursor, "}") && cursor.offset == cursor.length;
    }
    if (cursor.offset >= cursor.length || input[cursor.offset] != '{' ||
        input[input_length - 1U] != '}' || input_length - cursor.offset < 3U ||
        !mob_validate_probe_json(
            input + cursor.offset,
            input_length - cursor.offset - 1U)) {
        return false;
    }
    cursor.offset = input_length;
    return true;
}

bool mob_render_ssh_config(
    const mob_role_record *record,
    const char *identity_path,
    const char *agent_path,
    const char *known_hosts_path,
    char *output,
    size_t output_capacity,
    size_t *output_length
) {
    mob_text_writer writer;
    char port[8];
    char canonical_target[MOB_TARGET_MAX_BYTES + 1U];
    char canonical_username[MOB_USERNAME_MAX_BYTES + 1U];
    int port_length;
    if (record == NULL || output == NULL || output_length == NULL || output_capacity == 0U ||
        !mob_validate_target(record->target_kind, (const uint8_t *)record->target, strlen(record->target), canonical_target) ||
        !mob_validate_username((const uint8_t *)record->username, strlen(record->username), canonical_username) ||
        !mob_validate_internal_path(identity_path) || !mob_validate_internal_path(agent_path) ||
        !mob_validate_internal_path(known_hosts_path) || record->port == 0U) {
        return false;
    }
    port_length = snprintf(port, sizeof(port), "%u", (unsigned int)record->port);
    if (port_length <= 0 || (size_t)port_length >= sizeof(port)) {
        return false;
    }
    writer.data = output;
    writer.capacity = output_capacity;
    writer.length = 0U;
    writer.valid = true;
    output[0] = '\0';
#define MOB_CONFIG_LINE(key, value) \
    do { \
        mob_writer_append(&writer, key " "); \
        mob_writer_append(&writer, (value)); \
        mob_writer_append(&writer, "\n"); \
    } while (0)
    MOB_CONFIG_LINE("Host", "broker-fnos-v1");
    MOB_CONFIG_LINE("HostName", canonical_target);
    MOB_CONFIG_LINE("User", canonical_username);
    MOB_CONFIG_LINE("Port", port);
    MOB_CONFIG_LINE("BatchMode", "yes");
    MOB_CONFIG_LINE("PubkeyAuthentication", "yes");
    MOB_CONFIG_LINE("PreferredAuthentications", "publickey");
    MOB_CONFIG_LINE("PasswordAuthentication", "no");
    MOB_CONFIG_LINE("KbdInteractiveAuthentication", "no");
    MOB_CONFIG_LINE("NoHostAuthenticationForLocalhost", "no");
    MOB_CONFIG_LINE("GSSAPIAuthentication", "no");
    MOB_CONFIG_LINE("HostbasedAuthentication", "no");
    MOB_CONFIG_LINE("NumberOfPasswordPrompts", "0");
    MOB_CONFIG_LINE("RequestTTY", "no");
    MOB_CONFIG_LINE("StdinNull", "yes");
    MOB_CONFIG_LINE("ForkAfterAuthentication", "no");
    MOB_CONFIG_LINE("EnableEscapeCommandline", "no");
    MOB_CONFIG_LINE("SessionType", "default");
    MOB_CONFIG_LINE("IdentitiesOnly", "yes");
    MOB_CONFIG_LINE("IdentityFile", identity_path);
    MOB_CONFIG_LINE("IdentityAgent", agent_path);
    MOB_CONFIG_LINE("AddKeysToAgent", "no");
    MOB_CONFIG_LINE("SecurityKeyProvider", "none");
    MOB_CONFIG_LINE("PKCS11Provider", "none");
    MOB_CONFIG_LINE("StrictHostKeyChecking", "yes");
    MOB_CONFIG_LINE("UserKnownHostsFile", known_hosts_path);
    MOB_CONFIG_LINE("GlobalKnownHostsFile", "none");
    MOB_CONFIG_LINE("KnownHostsCommand", "none");
    MOB_CONFIG_LINE("HostKeyAlias", MOB_HOST_KEY_ALIAS);
    MOB_CONFIG_LINE("HostKeyAlgorithms", MOB_HOST_KEY_ALGORITHM);
    MOB_CONFIG_LINE("PubkeyAcceptedAlgorithms", MOB_IDENTITY_ALGORITHM);
    MOB_CONFIG_LINE("CheckHostIP", "no");
    MOB_CONFIG_LINE("UpdateHostKeys", "no");
    MOB_CONFIG_LINE("VerifyHostKeyDNS", "no");
    MOB_CONFIG_LINE("ForwardAgent", "no");
    MOB_CONFIG_LINE("ForwardX11", "no");
    MOB_CONFIG_LINE("ForwardX11Trusted", "no");
    MOB_CONFIG_LINE("ClearAllForwardings", "yes");
    MOB_CONFIG_LINE("PermitRemoteOpen", "none");
    MOB_CONFIG_LINE("ExitOnForwardFailure", "yes");
    MOB_CONFIG_LINE("Tunnel", "no");
    MOB_CONFIG_LINE("PermitLocalCommand", "no");
    MOB_CONFIG_LINE("ProxyCommand", "none");
    MOB_CONFIG_LINE("ProxyJump", "none");
    MOB_CONFIG_LINE("RemoteCommand", "none");
    MOB_CONFIG_LINE("ControlMaster", "no");
    MOB_CONFIG_LINE("ControlPath", "none");
    MOB_CONFIG_LINE("ControlPersist", "no");
    MOB_CONFIG_LINE("CanonicalizeHostname", "no");
    MOB_CONFIG_LINE("ConnectionAttempts", "1");
    MOB_CONFIG_LINE("ConnectTimeout", "10");
    MOB_CONFIG_LINE("LogLevel", "ERROR");
#undef MOB_CONFIG_LINE
    if (!writer.valid) {
        output[0] = '\0';
        return false;
    }
    *output_length = writer.length;
    return true;
}

typedef enum {
    MOB_SSH_HOST = 0,
    MOB_SSH_HOSTNAME,
    MOB_SSH_USER,
    MOB_SSH_PORT,
    MOB_SSH_BATCHMODE,
    MOB_SSH_PUBKEY_AUTH,
    MOB_SSH_PREFERRED_AUTH,
    MOB_SSH_PASSWORD_AUTH,
    MOB_SSH_KBD_AUTH,
    MOB_SSH_NO_HOST_AUTH_LOCALHOST,
    MOB_SSH_GSSAPI_AUTH,
    MOB_SSH_HOSTBASED_AUTH,
    MOB_SSH_PROMPTS,
    MOB_SSH_REQUEST_TTY,
    MOB_SSH_STDIN_NULL,
    MOB_SSH_FORK_AFTER_AUTH,
    MOB_SSH_ENABLE_ESCAPE_COMMANDLINE,
    MOB_SSH_SESSION_TYPE,
    MOB_SSH_IDENTITIES_ONLY,
    MOB_SSH_IDENTITY_FILE,
    MOB_SSH_IDENTITY_AGENT,
    MOB_SSH_ADD_KEYS_TO_AGENT,
    MOB_SSH_SECURITY_KEY_PROVIDER,
    MOB_SSH_PKCS11_PROVIDER,
    MOB_SSH_STRICT_HOSTKEY,
    MOB_SSH_USER_KNOWN_HOSTS,
    MOB_SSH_GLOBAL_KNOWN_HOSTS,
    MOB_SSH_KNOWN_HOSTS_COMMAND,
    MOB_SSH_HOSTKEY_ALIAS,
    MOB_SSH_HOSTKEY_ALGORITHMS,
    MOB_SSH_PUBKEY_ALGORITHMS,
    MOB_SSH_CHECK_HOST_IP,
    MOB_SSH_UPDATE_HOSTKEYS,
    MOB_SSH_VERIFY_DNS,
    MOB_SSH_FORWARD_AGENT,
    MOB_SSH_FORWARD_X11,
    MOB_SSH_FORWARD_X11_TRUSTED,
    MOB_SSH_CLEAR_FORWARDINGS,
    MOB_SSH_PERMIT_REMOTE_OPEN,
    MOB_SSH_EXIT_FORWARD_FAILURE,
    MOB_SSH_TUNNEL,
    MOB_SSH_PERMIT_LOCAL_COMMAND,
    MOB_SSH_PROXY_COMMAND,
    MOB_SSH_PROXY_JUMP,
    MOB_SSH_REMOTE_COMMAND,
    MOB_SSH_CONTROL_MASTER,
    MOB_SSH_CONTROL_PATH,
    MOB_SSH_CONTROL_PERSIST,
    MOB_SSH_CANONICALIZE,
    MOB_SSH_CONNECTION_ATTEMPTS,
    MOB_SSH_CONNECT_TIMEOUT,
    MOB_SSH_REQUIRED_COUNT
} mob_ssh_required_key;

static bool mob_ssh_boolean_is(const char *value, bool expected) {
    if (value == NULL) {
        return false;
    }
    if (expected) {
        return strcmp(value, "yes") == 0 || strcmp(value, "true") == 0;
    }
    return strcmp(value, "no") == 0 || strcmp(value, "false") == 0;
}

static bool mob_ssh_required(
    bool seen[MOB_SSH_REQUIRED_COUNT],
    mob_ssh_required_key key,
    const char *actual,
    const char *expected
) {
    if (seen[key] || actual == NULL || expected == NULL || strcmp(actual, expected) != 0) {
        return false;
    }
    seen[key] = true;
    return true;
}

static bool mob_ssh_required_boolean(
    bool seen[MOB_SSH_REQUIRED_COUNT],
    mob_ssh_required_key key,
    const char *actual,
    bool expected
) {
    if (seen[key] || !mob_ssh_boolean_is(actual, expected)) {
        return false;
    }
    seen[key] = true;
    return true;
}

static bool mob_ssh_benign_key(const char *key) {
    static const char *const keys[] = {
        "addressfamily", "authenticationmethods",
        "canonicaldomains", "canonicalizefallbacklocal", "canonicalizemaxdots",
        "canonicalizepermittedcnames", "casignaturealgorithms", "channeltimeout",
        "ciphers", "compression", "enablesshkeysign",
        "escapechar", "fingerprinthash",
        "forwardx11timeout", "gatewayports", "gssapidelegatecredentials",
        "hashknownhosts", "hostbasedacceptedalgorithms", "hostkeyalias",
        "ipqos", "kbdinteractivedevices", "loglevel", "logverbose", "macs",
        "applemultipath", "kexalgorithms",
        "nohostauthenticationforproxycommand", "obscurekeystroketiming",
        "proxyusefdpass", "rekeylimit", "requiredrsasize",
        "serveralivecountmax", "serveraliveinterval",
        "streamlocalbindmask", "streamlocalbindunlink",
        "syslogfacility", "tcpkeepalive", "tunneldevice", "visualhostkey",
        "xauthlocation"
    };
    return mob_string_in_set(key, keys, sizeof(keys) / sizeof(keys[0]));
}

static bool mob_ssh_may_be_omitted(mob_ssh_required_key key) {
    return key == MOB_SSH_KNOWN_HOSTS_COMMAND || key == MOB_SSH_PROXY_COMMAND ||
           key == MOB_SSH_PROXY_JUMP || key == MOB_SSH_REMOTE_COMMAND ||
           key == MOB_SSH_CONTROL_PATH || key == MOB_SSH_SECURITY_KEY_PROVIDER ||
           key == MOB_SSH_PKCS11_PROVIDER;
}

bool mob_verify_ssh_effective_config(
    const char *expanded,
    size_t expanded_length,
    const mob_role_record *record,
    const char *identity_path,
    const char *agent_path,
    const char *known_hosts_path
) {
    size_t offset = 0U;
    bool seen[MOB_SSH_REQUIRED_COUNT] = {false};
    char seen_keys[256][64];
    size_t seen_key_count = 0U;
    char expected_port[8];
    int expected_port_length;
    if (expanded == NULL || record == NULL || identity_path == NULL || agent_path == NULL ||
        known_hosts_path == NULL || expanded_length == 0U || expanded_length > 65536U ||
        memchr(expanded, '\0', expanded_length) != NULL || memchr(expanded, '\r', expanded_length) != NULL) {
        return false;
    }
    expected_port_length = snprintf(expected_port, sizeof(expected_port), "%u", (unsigned int)record->port);
    if (expected_port_length <= 0 || (size_t)expected_port_length >= sizeof(expected_port)) {
        return false;
    }
    while (offset < expanded_length) {
        size_t line_end = offset;
        size_t separator;
        size_t key_length;
        size_t value_length;
        char key[64];
        char value[2048];
        size_t index;
        bool accepted = false;
        while (line_end < expanded_length && expanded[line_end] != '\n') {
            ++line_end;
        }
        if (line_end == offset) {
            return false;
        }
        separator = offset;
        while (separator < line_end && expanded[separator] != ' ' && expanded[separator] != '\t') {
            ++separator;
        }
        if (separator == offset || separator == line_end) {
            return false;
        }
        key_length = separator - offset;
        while (separator < line_end && (expanded[separator] == ' ' || expanded[separator] == '\t')) {
            ++separator;
        }
        value_length = line_end - separator;
        if (key_length >= sizeof(key) || value_length == 0U || value_length >= sizeof(value)) {
            return false;
        }
        for (index = 0U; index < key_length; ++index) {
            const unsigned char character = (unsigned char)expanded[offset + index];
            if (!((character >= 'A' && character <= 'Z') ||
                  (character >= 'a' && character <= 'z') ||
                  (character >= '0' && character <= '9') || character == '-')) {
                return false;
            }
            key[index] = (char)(
                character >= 'A' && character <= 'Z' ? character + ('a' - 'A') : character
            );
        }
        key[key_length] = '\0';
        if (seen_key_count == sizeof(seen_keys) / sizeof(seen_keys[0])) {
            return false;
        }
        for (index = 0U; index < seen_key_count; ++index) {
            if (strcmp(seen_keys[index], key) == 0) {
                return false;
            }
        }
        memcpy(seen_keys[seen_key_count], key, key_length + 1U);
        ++seen_key_count;
        memcpy(value, expanded + separator, value_length);
        value[value_length] = '\0';

#define MOB_SSH_TEXT(name, enum_key, expected_value) \
        if (strcmp(key, name) == 0) { accepted = mob_ssh_required(seen, enum_key, value, expected_value); }
#define MOB_SSH_BOOL(name, enum_key, expected_value) \
        if (strcmp(key, name) == 0) { accepted = mob_ssh_required_boolean(seen, enum_key, value, expected_value); }
        MOB_SSH_TEXT("host", MOB_SSH_HOST, "broker-fnos-v1")
        else MOB_SSH_TEXT("hostname", MOB_SSH_HOSTNAME, record->target)
        else MOB_SSH_TEXT("user", MOB_SSH_USER, record->username)
        else MOB_SSH_TEXT("port", MOB_SSH_PORT, expected_port)
        else MOB_SSH_BOOL("batchmode", MOB_SSH_BATCHMODE, true)
        else MOB_SSH_BOOL("pubkeyauthentication", MOB_SSH_PUBKEY_AUTH, true)
        else MOB_SSH_TEXT("preferredauthentications", MOB_SSH_PREFERRED_AUTH, "publickey")
        else MOB_SSH_BOOL("passwordauthentication", MOB_SSH_PASSWORD_AUTH, false)
        else MOB_SSH_BOOL("kbdinteractiveauthentication", MOB_SSH_KBD_AUTH, false)
        else MOB_SSH_BOOL("nohostauthenticationforlocalhost", MOB_SSH_NO_HOST_AUTH_LOCALHOST, false)
        else MOB_SSH_BOOL("gssapiauthentication", MOB_SSH_GSSAPI_AUTH, false)
        else MOB_SSH_BOOL("hostbasedauthentication", MOB_SSH_HOSTBASED_AUTH, false)
        else MOB_SSH_TEXT("numberofpasswordprompts", MOB_SSH_PROMPTS, "0")
        else MOB_SSH_TEXT("requesttty", MOB_SSH_REQUEST_TTY, "false")
        else MOB_SSH_BOOL("stdinnull", MOB_SSH_STDIN_NULL, true)
        else MOB_SSH_BOOL("forkafterauthentication", MOB_SSH_FORK_AFTER_AUTH, false)
        else MOB_SSH_BOOL("enableescapecommandline", MOB_SSH_ENABLE_ESCAPE_COMMANDLINE, false)
        else MOB_SSH_TEXT("sessiontype", MOB_SSH_SESSION_TYPE, "default")
        else MOB_SSH_BOOL("identitiesonly", MOB_SSH_IDENTITIES_ONLY, true)
        else MOB_SSH_TEXT("identityfile", MOB_SSH_IDENTITY_FILE, identity_path)
        else MOB_SSH_TEXT("identityagent", MOB_SSH_IDENTITY_AGENT, agent_path)
        else MOB_SSH_BOOL("addkeystoagent", MOB_SSH_ADD_KEYS_TO_AGENT, false)
        else MOB_SSH_TEXT("securitykeyprovider", MOB_SSH_SECURITY_KEY_PROVIDER, "none")
        else MOB_SSH_TEXT("pkcs11provider", MOB_SSH_PKCS11_PROVIDER, "none")
        else MOB_SSH_BOOL("stricthostkeychecking", MOB_SSH_STRICT_HOSTKEY, true)
        else MOB_SSH_TEXT("userknownhostsfile", MOB_SSH_USER_KNOWN_HOSTS, known_hosts_path)
        else MOB_SSH_TEXT("globalknownhostsfile", MOB_SSH_GLOBAL_KNOWN_HOSTS, "none")
        else MOB_SSH_TEXT("knownhostscommand", MOB_SSH_KNOWN_HOSTS_COMMAND, "none")
        else MOB_SSH_TEXT("hostkeyalias", MOB_SSH_HOSTKEY_ALIAS, MOB_HOST_KEY_ALIAS)
        else MOB_SSH_TEXT("hostkeyalgorithms", MOB_SSH_HOSTKEY_ALGORITHMS, MOB_HOST_KEY_ALGORITHM)
        else MOB_SSH_TEXT("pubkeyacceptedalgorithms", MOB_SSH_PUBKEY_ALGORITHMS, MOB_IDENTITY_ALGORITHM)
        else MOB_SSH_BOOL("checkhostip", MOB_SSH_CHECK_HOST_IP, false)
        else MOB_SSH_BOOL("updatehostkeys", MOB_SSH_UPDATE_HOSTKEYS, false)
        else MOB_SSH_BOOL("verifyhostkeydns", MOB_SSH_VERIFY_DNS, false)
        else MOB_SSH_BOOL("forwardagent", MOB_SSH_FORWARD_AGENT, false)
        else MOB_SSH_BOOL("forwardx11", MOB_SSH_FORWARD_X11, false)
        else MOB_SSH_BOOL("forwardx11trusted", MOB_SSH_FORWARD_X11_TRUSTED, false)
        else MOB_SSH_BOOL("clearallforwardings", MOB_SSH_CLEAR_FORWARDINGS, true)
        else MOB_SSH_TEXT("permitremoteopen", MOB_SSH_PERMIT_REMOTE_OPEN, "none")
        else MOB_SSH_BOOL("exitonforwardfailure", MOB_SSH_EXIT_FORWARD_FAILURE, true)
        else MOB_SSH_BOOL("tunnel", MOB_SSH_TUNNEL, false)
        else MOB_SSH_BOOL("permitlocalcommand", MOB_SSH_PERMIT_LOCAL_COMMAND, false)
        else MOB_SSH_TEXT("proxycommand", MOB_SSH_PROXY_COMMAND, "none")
        else MOB_SSH_TEXT("proxyjump", MOB_SSH_PROXY_JUMP, "none")
        else MOB_SSH_TEXT("remotecommand", MOB_SSH_REMOTE_COMMAND, "none")
        else MOB_SSH_BOOL("controlmaster", MOB_SSH_CONTROL_MASTER, false)
        else MOB_SSH_TEXT("controlpath", MOB_SSH_CONTROL_PATH, "none")
        else MOB_SSH_BOOL("controlpersist", MOB_SSH_CONTROL_PERSIST, false)
        else MOB_SSH_BOOL("canonicalizehostname", MOB_SSH_CANONICALIZE, false)
        else MOB_SSH_TEXT("connectionattempts", MOB_SSH_CONNECTION_ATTEMPTS, "1")
        else MOB_SSH_TEXT("connecttimeout", MOB_SSH_CONNECT_TIMEOUT, "10")
        else if (strcmp(key, "sendenv") == 0 || strcmp(key, "setenv") == 0 ||
                 strcmp(key, "localforward") == 0 || strcmp(key, "remoteforward") == 0 ||
                 strcmp(key, "dynamicforward") == 0) {
            return false;
        } else {
            accepted = mob_ssh_benign_key(key);
        }
#undef MOB_SSH_TEXT
#undef MOB_SSH_BOOL
        if (!accepted) {
            return false;
        }
        offset = line_end < expanded_length ? line_end + 1U : line_end;
    }
    for (offset = 0U; offset < MOB_SSH_REQUIRED_COUNT; ++offset) {
        if (!seen[offset] && !mob_ssh_may_be_omitted((mob_ssh_required_key)offset)) {
            return false;
        }
    }
    return true;
}

bool mob_cleanup_transition(mob_cleanup_state *state, mob_cleanup_state next_state) {
    bool allowed = false;
    if (state == NULL) {
        return false;
    }
    switch (*state) {
        case MOB_CLEANUP_INIT:
            allowed = next_state == MOB_CLEANUP_RESOURCES_READY || next_state == MOB_CLEANUP_CLEANING;
            break;
        case MOB_CLEANUP_RESOURCES_READY:
            allowed = next_state == MOB_CLEANUP_CHILD_RUNNING || next_state == MOB_CLEANUP_CLEANING;
            break;
        case MOB_CLEANUP_CHILD_RUNNING:
            allowed = next_state == MOB_CLEANUP_CLEANING;
            break;
        case MOB_CLEANUP_CLEANING:
            allowed = next_state == MOB_CLEANUP_DONE || next_state == MOB_CLEANUP_FAILED;
            break;
        case MOB_CLEANUP_DONE:
        case MOB_CLEANUP_FAILED:
            allowed = false;
            break;
        default:
            allowed = false;
            break;
    }
    if (allowed) {
        *state = next_state;
    }
    return allowed;
}

static bool mob_agent_take(
    const uint8_t *request,
    size_t request_length,
    size_t *offset,
    const uint8_t **value,
    size_t *value_length
) {
    uint32_t length;
    if (request == NULL || offset == NULL || value == NULL || value_length == NULL ||
        *offset > request_length || request_length - *offset < 4U) {
        return false;
    }
    length = mob_read_u32(request + *offset);
    *offset += 4U;
    if ((size_t)length > request_length - *offset) {
        return false;
    }
    *value = request + *offset;
    *value_length = (size_t)length;
    *offset += (size_t)length;
    return true;
}

bool mob_parse_agent_request(
    const uint8_t *request,
    size_t request_length,
    const uint8_t *exact_public_key,
    size_t exact_public_key_length,
    mob_agent_request *parsed
) {
    const uint8_t *requested_key;
    const uint8_t *sign_data;
    size_t requested_key_length;
    size_t sign_data_length;
    size_t offset = 1U;
    if (request == NULL || exact_public_key == NULL || exact_public_key_length == 0U || parsed == NULL ||
        request_length == 0U || request_length > 65536U) {
        return false;
    }
    parsed->type = MOB_AGENT_REQUEST_REJECT;
    parsed->sign_data = NULL;
    parsed->sign_data_length = 0U;
    if (request[0] == 11U && request_length == 1U) {
        parsed->type = MOB_AGENT_REQUEST_IDENTITIES;
        return true;
    }
    if (request[0] != 13U ||
        !mob_agent_take(request, request_length, &offset, &requested_key, &requested_key_length) ||
        !mob_agent_take(request, request_length, &offset, &sign_data, &sign_data_length) ||
        request_length - offset != 4U || mob_read_u32(request + offset) != 0U ||
        requested_key_length != exact_public_key_length ||
        memcmp(requested_key, exact_public_key, exact_public_key_length) != 0 ||
        sign_data_length == 0U || sign_data_length > 32768U) {
        return false;
    }
    parsed->type = MOB_AGENT_REQUEST_SIGN;
    parsed->sign_data = sign_data;
    parsed->sign_data_length = sign_data_length;
    return true;
}

typedef struct {
    uint32_t state[8];
    uint64_t bit_length;
    uint8_t block[64];
    size_t block_length;
} mob_sha256_context;

static uint32_t mob_rotr32(uint32_t value, unsigned int shift) {
    return (value >> shift) | (value << (32U - shift));
}

static void mob_sha256_transform(mob_sha256_context *context, const uint8_t block[64]) {
    static const uint32_t constants[64] = {
        0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
        0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
        0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
        0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
        0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
        0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
        0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
        0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
        0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
        0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
        0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
        0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
        0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
        0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
        0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
        0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U
    };
    uint32_t words[64];
    uint32_t a;
    uint32_t b;
    uint32_t c;
    uint32_t d;
    uint32_t e;
    uint32_t f;
    uint32_t g;
    uint32_t h;
    size_t index;
    for (index = 0U; index < 16U; ++index) {
        words[index] = mob_read_u32(block + (index * 4U));
    }
    for (index = 16U; index < 64U; ++index) {
        const uint32_t s0 = mob_rotr32(words[index - 15U], 7U) ^ mob_rotr32(words[index - 15U], 18U) ^ (words[index - 15U] >> 3U);
        const uint32_t s1 = mob_rotr32(words[index - 2U], 17U) ^ mob_rotr32(words[index - 2U], 19U) ^ (words[index - 2U] >> 10U);
        words[index] = words[index - 16U] + s0 + words[index - 7U] + s1;
    }
    a = context->state[0];
    b = context->state[1];
    c = context->state[2];
    d = context->state[3];
    e = context->state[4];
    f = context->state[5];
    g = context->state[6];
    h = context->state[7];
    for (index = 0U; index < 64U; ++index) {
        const uint32_t sigma1 = mob_rotr32(e, 6U) ^ mob_rotr32(e, 11U) ^ mob_rotr32(e, 25U);
        const uint32_t choose = (e & f) ^ ((~e) & g);
        const uint32_t temporary1 = h + sigma1 + choose + constants[index] + words[index];
        const uint32_t sigma0 = mob_rotr32(a, 2U) ^ mob_rotr32(a, 13U) ^ mob_rotr32(a, 22U);
        const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        const uint32_t temporary2 = sigma0 + majority;
        h = g;
        g = f;
        f = e;
        e = d + temporary1;
        d = c;
        c = b;
        b = a;
        a = temporary1 + temporary2;
    }
    context->state[0] += a;
    context->state[1] += b;
    context->state[2] += c;
    context->state[3] += d;
    context->state[4] += e;
    context->state[5] += f;
    context->state[6] += g;
    context->state[7] += h;
}

static void mob_sha256_init(mob_sha256_context *context) {
    static const uint32_t initial[8] = {
        0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
        0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U
    };
    memcpy(context->state, initial, sizeof(initial));
    context->bit_length = 0U;
    context->block_length = 0U;
}

static void mob_sha256_update(mob_sha256_context *context, const uint8_t *input, size_t input_length) {
    size_t index;
    for (index = 0U; index < input_length; ++index) {
        context->block[context->block_length++] = input[index];
        if (context->block_length == sizeof(context->block)) {
            mob_sha256_transform(context, context->block);
            context->bit_length += 512U;
            context->block_length = 0U;
        }
    }
}

static void mob_sha256_final(mob_sha256_context *context, uint8_t output[32]) {
    size_t index = context->block_length;
    uint64_t total_bits;
    context->block[index++] = 0x80U;
    if (index > 56U) {
        while (index < 64U) {
            context->block[index++] = 0U;
        }
        mob_sha256_transform(context, context->block);
        index = 0U;
    }
    while (index < 56U) {
        context->block[index++] = 0U;
    }
    total_bits = context->bit_length + ((uint64_t)context->block_length * 8U);
    mob_write_u64(context->block + 56U, total_bits);
    mob_sha256_transform(context, context->block);
    for (index = 0U; index < 8U; ++index) {
        mob_write_u32(output + (index * 4U), context->state[index]);
    }
    memset(context, 0, sizeof(*context));
}

void mob_sha256(const uint8_t *input, size_t input_length, uint8_t output[32]) {
    mob_sha256_context context;
    if (output == NULL || (input == NULL && input_length != 0U)) {
        return;
    }
    mob_sha256_init(&context);
    if (input_length > 0U) {
        mob_sha256_update(&context, input, input_length);
    }
    mob_sha256_final(&context, output);
}

bool mob_base64_encode(
    const uint8_t *input,
    size_t input_length,
    char *output,
    size_t output_capacity,
    size_t *output_length
) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t input_offset = 0U;
    size_t output_offset = 0U;
    const size_t required = ((input_length + 2U) / 3U) * 4U;
    if (output == NULL || output_length == NULL || (input == NULL && input_length != 0U) ||
        required + 1U > output_capacity) {
        return false;
    }
    while (input_offset < input_length) {
        const size_t remaining = input_length - input_offset;
        const uint32_t first = input[input_offset++];
        const uint32_t second = remaining > 1U ? input[input_offset++] : 0U;
        const uint32_t third = remaining > 2U ? input[input_offset++] : 0U;
        const uint32_t value = (first << 16U) | (second << 8U) | third;
        output[output_offset++] = alphabet[(value >> 18U) & 0x3fU];
        output[output_offset++] = alphabet[(value >> 12U) & 0x3fU];
        output[output_offset++] = remaining > 1U ? alphabet[(value >> 6U) & 0x3fU] : '=';
        output[output_offset++] = remaining > 2U ? alphabet[value & 0x3fU] : '=';
    }
    output[output_offset] = '\0';
    *output_length = output_offset;
    return true;
}

static bool mob_blob_append_string(
    uint8_t *output,
    size_t capacity,
    size_t *offset,
    const uint8_t *value,
    size_t value_length
) {
    if (output == NULL || offset == NULL || value == NULL || value_length > UINT32_MAX ||
        *offset > capacity || capacity - *offset < 4U || value_length > capacity - *offset - 4U) {
        return false;
    }
    mob_write_u32(output + *offset, (uint32_t)value_length);
    memcpy(output + *offset + 4U, value, value_length);
    *offset += 4U + value_length;
    return true;
}

bool mob_make_ed25519_key_blob(
    const uint8_t raw_key[32],
    uint8_t *output,
    size_t capacity,
    size_t *length
) {
    size_t offset = 0U;
    if (raw_key == NULL || output == NULL || length == NULL ||
        !mob_blob_append_string(output, capacity, &offset, (const uint8_t *)MOB_HOST_KEY_ALGORITHM, strlen(MOB_HOST_KEY_ALGORITHM)) ||
        !mob_blob_append_string(output, capacity, &offset, raw_key, 32U)) {
        return false;
    }
    *length = offset;
    return true;
}

bool mob_make_p256_key_blob(
    const uint8_t *x963_key,
    size_t key_length,
    uint8_t *output,
    size_t capacity,
    size_t *length
) {
    size_t offset = 0U;
    if (x963_key == NULL || key_length != 65U || x963_key[0] != 0x04U ||
        output == NULL || length == NULL ||
        !mob_blob_append_string(output, capacity, &offset, (const uint8_t *)MOB_IDENTITY_ALGORITHM, strlen(MOB_IDENTITY_ALGORITHM)) ||
        !mob_blob_append_string(output, capacity, &offset, (const uint8_t *)"nistp256", 8U) ||
        !mob_blob_append_string(output, capacity, &offset, x963_key, key_length)) {
        return false;
    }
    *length = offset;
    return true;
}
