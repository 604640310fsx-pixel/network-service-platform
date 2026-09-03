#import <AppKit/AppKit.h>
#import <CoreFoundation/CoreFoundation.h>
#import <Security/SecCode.h>
#import <Security/SecKey.h>
#import <Security/SecStaticCode.h>
#import <Security/Security.h>
#import <mach-o/dyld.h>
#import <errno.h>
#import <limits.h>
#import <stdlib.h>
#import <string.h>
#import <sys/stat.h>
#import <time.h>

#include "local_opaque_operation_broker_core.h"

static NSString *const MOBAdminRole = @"FNOS_PRODUCTION";
static NSString *const MOBAdminOperation = @"RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1";
static NSString *const MOBAdminService = @"com.network-service-platform.monitor-opaque-broker.role-record.v1";
static NSString *const MOBAdminBrokerPath = @"/usr/local/libexec/network-service-platform/monitor-opaque-operation-broker-v1";
static NSString *const MOBAdminExecutablePath = @"/usr/local/libexec/network-service-platform/monitor-opaque-operation-broker-admin-v1";
static NSString *const MOBAdminKeyTag = @"com.network-service-platform.monitor-opaque-broker.identity.FNOS_PRODUCTION.v1";

typedef NS_ENUM(NSInteger, MOBAdminAction) {
    MOBAdminActionProvision = 0,
    MOBAdminActionReplace = 1,
    MOBAdminActionRevoke = 2,
};

static BOOL MOBRootOwnedExecutable(NSString *path) {
    struct stat metadata;
    const char *fileSystemPath = path.fileSystemRepresentation;
    return fileSystemPath != NULL && lstat(fileSystemPath, &metadata) == 0 &&
           S_ISREG(metadata.st_mode) && metadata.st_uid == 0 && metadata.st_gid == 0 &&
           (metadata.st_mode & 07777U) == 0555U;
}

static BOOL MOBRootOwnedAncestors(NSString *path) {
    const char *fileSystemPath = path.fileSystemRepresentation;
    char copy[PATH_MAX];
    char *separator;
    if (fileSystemPath == NULL || strlen(fileSystemPath) >= sizeof(copy) || fileSystemPath[0] != '/') {
        return NO;
    }
    memcpy(copy, fileSystemPath, strlen(fileSystemPath) + 1U);
    separator = copy + 1;
    while ((separator = strchr(separator, '/')) != NULL) {
        struct stat metadata;
        *separator = '\0';
        if (lstat(copy, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_uid != 0U ||
            (metadata.st_mode & (S_IWGRP | S_IWOTH)) != 0U) {
            return NO;
        }
        *separator = '/';
        ++separator;
    }
    NSString *directory = path.stringByDeletingLastPathComponent;
    struct stat directoryMetadata;
    return lstat(directory.fileSystemRepresentation, &directoryMetadata) == 0 &&
           S_ISDIR(directoryMetadata.st_mode) && directoryMetadata.st_uid == 0U &&
           directoryMetadata.st_gid == 0U && (directoryMetadata.st_mode & 07777U) == 0755U;
}

static BOOL MOBAdminSelfAtExpectedPath(void) {
    char executable[PATH_MAX];
    char resolved[PATH_MAX];
    uint32_t length = (uint32_t)sizeof(executable);
    return _NSGetExecutablePath(executable, &length) == 0 &&
           realpath(executable, resolved) != NULL &&
           strcmp(resolved, MOBAdminExecutablePath.fileSystemRepresentation) == 0;
}

static BOOL MOBStableSignedCode(NSString *path) {
    NSURL *url = [NSURL fileURLWithPath:path];
    SecStaticCodeRef code = NULL;
    CFDictionaryRef information = NULL;
    SecRequirementRef designated = NULL;
    uint32_t flags = 0U;
    BOOL valid = NO;
    if (SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code) != errSecSuccess ||
        code == NULL || SecStaticCodeCheckValidity(code, kSecCSStrictValidate, NULL) != errSecSuccess ||
        SecCodeCopyDesignatedRequirement(code, kSecCSDefaultFlags, &designated) != errSecSuccess ||
        designated == NULL ||
        SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information) != errSecSuccess ||
        information == NULL) {
        goto done;
    }
    CFTypeRef rawFlags = CFDictionaryGetValue(information, kSecCodeInfoFlags);
    CFTypeRef identifier = CFDictionaryGetValue(information, kSecCodeInfoIdentifier);
    CFTypeRef entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
    if (rawFlags == NULL || CFGetTypeID(rawFlags) != CFNumberGetTypeID() ||
        !CFNumberGetValue((CFNumberRef)rawFlags, kCFNumberSInt32Type, &flags) ||
        (flags & kSecCodeSignatureAdhoc) != 0U || (flags & kSecCodeSignatureRuntime) == 0U ||
        identifier == NULL || CFGetTypeID(identifier) != CFStringGetTypeID() ||
        CFStringGetLength((CFStringRef)identifier) == 0 || entitlements == NULL ||
        CFGetTypeID(entitlements) != CFDictionaryGetTypeID() ||
        CFDictionaryGetCount((CFDictionaryRef)entitlements) != 1) {
        goto done;
    }
    CFTypeRef getTaskAllow = CFDictionaryGetValue(
        (CFDictionaryRef)entitlements,
        CFSTR("com.apple.security.get-task-allow")
    );
    if (getTaskAllow == NULL || CFGetTypeID(getTaskAllow) != CFBooleanGetTypeID() ||
        CFBooleanGetValue((CFBooleanRef)getTaskAllow)) {
        goto done;
    }
    valid = YES;
done:
    if (information != NULL) {
        CFRelease(information);
    }
    if (designated != NULL) {
        CFRelease(designated);
    }
    if (code != NULL) {
        CFRelease(code);
    }
    return valid;
}

static NSData *MOBKeyTagData(void) {
    return [MOBAdminKeyTag dataUsingEncoding:NSUTF8StringEncoding];
}

static uint32_t MOBReadU32(const uint8_t *value) {
    return ((uint32_t)value[0] << 24U) |
           ((uint32_t)value[1] << 16U) |
           ((uint32_t)value[2] << 8U) |
           (uint32_t)value[3];
}

static BOOL MOBTakeSSHString(NSData *blob, NSUInteger *offset, NSData **value) {
    if (blob == nil || offset == NULL || value == NULL || *offset > blob.length || blob.length - *offset < 4U) {
        return NO;
    }
    const uint8_t *bytes = blob.bytes;
    uint32_t length = MOBReadU32(bytes + *offset);
    *offset += 4U;
    if ((NSUInteger)length > blob.length - *offset) {
        return NO;
    }
    *value = [blob subdataWithRange:NSMakeRange(*offset, (NSUInteger)length)];
    *offset += (NSUInteger)length;
    return YES;
}

static NSData *MOBParseEd25519HostKey(NSString *input) {
    NSArray<NSString *> *parts = [input componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSMutableArray<NSString *> *tokens = [NSMutableArray array];
    for (NSString *part in parts) {
        if (part.length > 0U) {
            [tokens addObject:part];
        }
    }
    if (tokens.count != 2U || ![tokens[0] isEqualToString:@"ssh-ed25519"]) {
        return nil;
    }
    NSData *blob = [[NSData alloc] initWithBase64EncodedString:tokens[1] options:0U];
    NSUInteger offset = 0U;
    NSData *algorithm = nil;
    NSData *rawKey = nil;
    NSData *expected = [@"ssh-ed25519" dataUsingEncoding:NSUTF8StringEncoding];
    if (!MOBTakeSSHString(blob, &offset, &algorithm) || ![algorithm isEqualToData:expected] ||
        !MOBTakeSSHString(blob, &offset, &rawKey) || rawKey.length != 32U || offset != blob.length) {
        return nil;
    }
    return rawKey;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static SecAccessRef MOBCreateExactAccess(void) {
    SecTrustedApplicationRef broker = NULL;
    SecTrustedApplicationRef admin = NULL;
    SecAccessRef access = NULL;
    CFMutableArrayRef applications = NULL;
    if (SecTrustedApplicationCreateFromPath(MOBAdminBrokerPath.fileSystemRepresentation, &broker) != errSecSuccess ||
        broker == NULL ||
        SecTrustedApplicationCreateFromPath(MOBAdminExecutablePath.fileSystemRepresentation, &admin) != errSecSuccess ||
        admin == NULL) {
        goto done;
    }
    applications = CFArrayCreateMutable(kCFAllocatorDefault, 2, &kCFTypeArrayCallBacks);
    if (applications == NULL) {
        goto done;
    }
    CFArrayAppendValue(applications, broker);
    CFArrayAppendValue(applications, admin);
    if (SecAccessCreate(
            CFSTR("Network Service Platform monitor opaque broker FNOS_PRODUCTION"),
            applications,
            &access) != errSecSuccess) {
        access = NULL;
    }
done:
    if (applications != NULL) {
        CFRelease(applications);
    }
    if (admin != NULL) {
        CFRelease(admin);
    }
    if (broker != NULL) {
        CFRelease(broker);
    }
    return access;
}
#pragma clang diagnostic pop

static NSDictionary *MOBExactRoleQuery(void) {
    return @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: MOBAdminService,
        (__bridge id)kSecAttrAccount: MOBAdminRole,
        (__bridge id)kSecAttrSynchronizable: @NO,
    };
}

static NSDictionary *MOBExactKeyQuery(void) {
    return @{
        (__bridge id)kSecClass: (__bridge id)kSecClassKey,
        (__bridge id)kSecAttrApplicationTag: MOBKeyTagData(),
        (__bridge id)kSecAttrKeyType: (__bridge id)kSecAttrKeyTypeECSECPrimeRandom,
        (__bridge id)kSecAttrSynchronizable: @NO,
    };
}

static BOOL MOBExactItemAbsent(NSDictionary *baseQuery) {
    NSMutableDictionary *query = [baseQuery mutableCopy];
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitAll;
    query[(__bridge id)kSecReturnAttributes] = @YES;
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (result != NULL) {
        CFRelease(result);
    }
    return status == errSecItemNotFound;
}

static BOOL MOBRevokeExactRole(void) {
    OSStatus recordStatus = SecItemDelete((__bridge CFDictionaryRef)MOBExactRoleQuery());
    OSStatus keyStatus = SecItemDelete((__bridge CFDictionaryRef)MOBExactKeyQuery());
    BOOL recordDeleted = recordStatus == errSecSuccess || recordStatus == errSecItemNotFound;
    BOOL keyDeleted = keyStatus == errSecSuccess || keyStatus == errSecItemNotFound;
    return recordDeleted && keyDeleted && MOBExactItemAbsent(MOBExactRoleQuery()) && MOBExactItemAbsent(MOBExactKeyQuery());
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static SecKeyRef MOBCreateIdentityKey(SecAccessRef access) {
    NSDictionary *privateAttributes = @{
        (__bridge id)kSecAttrIsPermanent: @YES,
        (__bridge id)kSecAttrIsExtractable: @NO,
        (__bridge id)kSecAttrCanSign: @YES,
        (__bridge id)kSecAttrApplicationTag: MOBKeyTagData(),
        (__bridge id)kSecAttrSynchronizable: @NO,
        (__bridge id)kSecAttrAccess: (__bridge id)access,
    };
    NSDictionary *attributes = @{
        (__bridge id)kSecAttrKeyType: (__bridge id)kSecAttrKeyTypeECSECPrimeRandom,
        (__bridge id)kSecAttrKeySizeInBits: @256,
        (__bridge id)kSecPrivateKeyAttrs: privateAttributes,
    };
    CFErrorRef error = NULL;
    SecKeyRef key = SecKeyCreateRandomKey((__bridge CFDictionaryRef)attributes, &error);
    if (error != NULL) {
        CFRelease(error);
    }
    return key;
}
#pragma clang diagnostic pop

static NSData *MOBPersistentReference(SecKeyRef key) {
    NSDictionary *query = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassKey,
        (__bridge id)kSecValueRef: (__bridge id)key,
        (__bridge id)kSecReturnPersistentRef: @YES,
        (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
    };
    CFTypeRef result = NULL;
    if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &result) != errSecSuccess ||
        result == NULL || CFGetTypeID(result) != CFDataGetTypeID()) {
        if (result != NULL) {
            CFRelease(result);
        }
        return nil;
    }
    return CFBridgingRelease(result);
}

static NSData *MOBPublicIdentityBlob(SecKeyRef privateKey) {
    SecKeyRef publicKey = SecKeyCopyPublicKey(privateKey);
    CFErrorRef error = NULL;
    CFDataRef external = publicKey == NULL ? NULL : SecKeyCopyExternalRepresentation(publicKey, &error);
    uint8_t blob[256];
    size_t blobLength = 0U;
    NSData *result = nil;
    if (external != NULL && CFDataGetLength(external) == 65 &&
        mob_make_p256_key_blob(
            CFDataGetBytePtr(external),
            (size_t)CFDataGetLength(external),
            blob,
            sizeof(blob),
            &blobLength)) {
        result = [NSData dataWithBytes:blob length:blobLength];
    }
    memset(blob, 0, sizeof(blob));
    if (external != NULL) {
        CFRelease(external);
    }
    if (error != NULL) {
        CFRelease(error);
    }
    if (publicKey != NULL) {
        CFRelease(publicKey);
    }
    return result;
}

static NSData *MOBEncodeRoleRecord(
    NSString *target,
    NSInteger port,
    NSString *username,
    NSData *hostKey,
    NSData *persistentReference,
    NSData *publicIdentity,
    unsigned long long expiration
) {
    mob_role_record record;
    uint8_t encoded[MOB_MOBR1_MAX_BYTES];
    size_t encodedLength = 0U;
    const char *targetBytes = target.UTF8String;
    const char *usernameBytes = username.UTF8String;
    char canonicalTarget[MOB_TARGET_MAX_BYTES + 1U];
    char canonicalUsername[MOB_USERNAME_MAX_BYTES + 1U];
    const char *targetKind = NULL;
    uint8_t digest[32];
    if (targetBytes == NULL || usernameBytes == NULL || port < 1 || port > 65535 ||
        hostKey.length != 32U || persistentReference.length == 0U ||
        persistentReference.length > MOB_PERSISTENT_REF_MAX_BYTES || publicIdentity.length == 0U ||
        expiration <= (unsigned long long)time(NULL)) {
        return nil;
    }
    if (mob_validate_target("IP", (const uint8_t *)targetBytes, strlen(targetBytes), canonicalTarget)) {
        targetKind = "IP";
    } else if (mob_validate_target("DNS", (const uint8_t *)targetBytes, strlen(targetBytes), canonicalTarget)) {
        targetKind = "DNS";
    } else {
        return nil;
    }
    if (!mob_validate_username((const uint8_t *)usernameBytes, strlen(usernameBytes), canonicalUsername)) {
        return nil;
    }
    memset(&record, 0, sizeof(record));
    record.version = MOB_RECORD_VERSION;
    strlcpy(record.role, MOB_ROLE, sizeof(record.role));
    strlcpy(record.operation, MOB_OPERATION, sizeof(record.operation));
    strlcpy(record.target_kind, targetKind, sizeof(record.target_kind));
    strlcpy(record.target, canonicalTarget, sizeof(record.target));
    record.port = (uint16_t)port;
    strlcpy(record.username, canonicalUsername, sizeof(record.username));
    strlcpy(record.host_key_algorithm, MOB_HOST_KEY_ALGORITHM, sizeof(record.host_key_algorithm));
    memcpy(record.host_key, hostKey.bytes, sizeof(record.host_key));
    memcpy(record.persistent_key_ref, persistentReference.bytes, persistentReference.length);
    record.persistent_key_ref_length = persistentReference.length;
    mob_sha256(publicIdentity.bytes, publicIdentity.length, digest);
    memcpy(record.identity_sha256, digest, sizeof(digest));
    strlcpy(record.command_profile, MOB_COMMAND_PROFILE, sizeof(record.command_profile));
    record.expires_at = (uint64_t)expiration;
    record.minimum_build = MOB_BROKER_BUILD;
    if (!mob_encode_mobr1(&record, encoded, sizeof(encoded), &encodedLength)) {
        memset(&record, 0, sizeof(record));
        memset(encoded, 0, sizeof(encoded));
        memset(digest, 0, sizeof(digest));
        return nil;
    }
    NSData *result = [NSData dataWithBytes:encoded length:encodedLength];
    memset(&record, 0, sizeof(record));
    memset(encoded, 0, sizeof(encoded));
    memset(digest, 0, sizeof(digest));
    return result;
}

static BOOL MOBValidateBindingInputs(
    NSString *target,
    NSInteger port,
    NSString *username,
    unsigned long long expiration
) {
    const char *targetBytes = target.UTF8String;
    const char *usernameBytes = username.UTF8String;
    char canonicalTarget[MOB_TARGET_MAX_BYTES + 1U];
    char canonicalUsername[MOB_USERNAME_MAX_BYTES + 1U];
    time_t now = time(NULL);
    return targetBytes != NULL && usernameBytes != NULL && port >= 1 && port <= 65535 &&
           now > 0 && expiration > (unsigned long long)now &&
           (mob_validate_target(
                "IP",
                (const uint8_t *)targetBytes,
                strlen(targetBytes),
                canonicalTarget
            ) ||
            mob_validate_target(
                "DNS",
                (const uint8_t *)targetBytes,
                strlen(targetBytes),
                canonicalTarget
            )) &&
           mob_validate_username(
               (const uint8_t *)usernameBytes,
               strlen(usernameBytes),
               canonicalUsername
           );
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static BOOL MOBAddRoleRecord(NSData *record, SecAccessRef access) {
    NSMutableDictionary *query = [MOBExactRoleQuery() mutableCopy];
    query[(__bridge id)kSecValueData] = record;
    query[(__bridge id)kSecAttrAccess] = (__bridge id)access;
    return SecItemAdd((__bridge CFDictionaryRef)query, NULL) == errSecSuccess;
}
#pragma clang diagnostic pop

static void MOBDeleteCreatedIdentity(SecKeyRef privateKey) {
    if (privateKey == NULL) {
        return;
    }
    NSDictionary *query = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassKey,
        (__bridge id)kSecValueRef: (__bridge id)privateKey,
    };
    (void)SecItemDelete((__bridge CFDictionaryRef)query);
}

static BOOL MOBProvision(
    MOBAdminAction action,
    NSString *target,
    NSInteger port,
    NSString *username,
    NSString *hostKeyText,
    unsigned long long expiration,
    NSData **publicEnrollment
) {
    SecAccessRef access = NULL;
    SecKeyRef privateKey = NULL;
    NSData *hostKey = MOBParseEd25519HostKey(hostKeyText);
    NSData *persistentReference = nil;
    NSData *publicIdentity = nil;
    NSData *record = nil;
    BOOL success = NO;
    if ((action != MOBAdminActionProvision && action != MOBAdminActionReplace) ||
        hostKey == nil || !MOBValidateBindingInputs(target, port, username, expiration) ||
        !MOBRootOwnedExecutable(MOBAdminBrokerPath) ||
        !MOBStableSignedCode(MOBAdminBrokerPath) ||
        !MOBRootOwnedExecutable(MOBAdminExecutablePath) ||
        !MOBStableSignedCode(MOBAdminExecutablePath)) {
        return NO;
    }
    if (action == MOBAdminActionReplace && !MOBRevokeExactRole()) {
        return NO;
    }
    if (action == MOBAdminActionProvision &&
        (!MOBExactItemAbsent(MOBExactRoleQuery()) || !MOBExactItemAbsent(MOBExactKeyQuery()))) {
        return NO;
    }
    access = MOBCreateExactAccess();
    if (access == NULL) {
        goto done;
    }
    privateKey = MOBCreateIdentityKey(access);
    if (privateKey == NULL) {
        goto done;
    }
    persistentReference = MOBPersistentReference(privateKey);
    publicIdentity = MOBPublicIdentityBlob(privateKey);
    if (persistentReference == nil || publicIdentity == nil) {
        goto done;
    }
    record = MOBEncodeRoleRecord(
        target,
        port,
        username,
        hostKey,
        persistentReference,
        publicIdentity,
        expiration
    );
    if (record == nil || !MOBAddRoleRecord(record, access)) {
        goto done;
    }
    success = YES;
    if (publicEnrollment != NULL) {
        *publicEnrollment = publicIdentity;
    }
done:
    if (!success) {
        MOBDeleteCreatedIdentity(privateKey);
    }
    if (privateKey != NULL) {
        CFRelease(privateKey);
    }
    if (access != NULL) {
        CFRelease(access);
    }
    return success;
}

static void MOBShowResult(BOOL success) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = success ? @"Operation completed" : @"Operation failed closed";
    alert.informativeText = success
        ? @"The exact FNOS_PRODUCTION role lifecycle operation completed."
        : @"No connection was attempted. Review signed installation and entered public binding values.";
    [alert addButtonWithTitle:@"OK"];
    [alert runModal];
}

static BOOL MOBSavePublicEnrollment(NSData *publicIdentity) {
    if (publicIdentity == nil) {
        return NO;
    }
    NSString *base64 = [publicIdentity base64EncodedStringWithOptions:0U];
    NSString *line = [NSString stringWithFormat:@"ecdsa-sha2-nistp256 %@ monitor-opaque-operation-broker-v1\n", base64];
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.nameFieldStringValue = @"monitor-opaque-operation-broker-public-key.pub";
    panel.canCreateDirectories = NO;
    if ([panel runModal] != NSModalResponseOK || panel.URL == nil) {
        return NO;
    }
    NSError *error = nil;
    BOOL saved = [line writeToURL:panel.URL atomically:YES encoding:NSUTF8StringEncoding error:&error];
    return saved && error == nil;
}

static BOOL MOBParseUnsignedDecimal(
    NSString *input,
    unsigned long long maximum,
    unsigned long long *value
) {
    const char *text = input.UTF8String;
    char *end = NULL;
    unsigned long long parsed;
    size_t index;
    size_t length;
    if (text == NULL || text[0] == '\0' || value == NULL) {
        return NO;
    }
    length = strlen(text);
    if ((length > 1U && text[0] == '0') || maximum == 0U) {
        return NO;
    }
    for (index = 0U; index < length; ++index) {
        if (text[index] < '0' || text[index] > '9') {
            return NO;
        }
    }
    errno = 0;
    parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || end == NULL || *end != '\0' || parsed > maximum) {
        return NO;
    }
    *value = parsed;
    return YES;
}

static NSView *MOBInputView(
    NSPopUpButton **action,
    NSTextField **target,
    NSTextField **port,
    NSTextField **username,
    NSTextField **hostKey,
    NSTextField **expiration
) {
    NSView *view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 520, 210)];
    NSArray<NSString *> *labels = @[@"Action", @"Canonical target", @"SSH port", @"Non-root username", @"Pinned ssh-ed25519 public key", @"Expiration (Unix epoch)"];
    NSMutableArray<NSView *> *controls = [NSMutableArray array];
    NSPopUpButton *actionControl = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
    [actionControl addItemsWithTitles:@[@"Provision", @"Replace", @"Revoke"]];
    [controls addObject:actionControl];
    NSTextField *targetControl = [[NSTextField alloc] initWithFrame:NSZeroRect];
    NSTextField *portControl = [[NSTextField alloc] initWithFrame:NSZeroRect];
    NSTextField *usernameControl = [[NSTextField alloc] initWithFrame:NSZeroRect];
    NSSecureTextField *hostKeyControl = [[NSSecureTextField alloc] initWithFrame:NSZeroRect];
    NSTextField *expirationControl = [[NSTextField alloc] initWithFrame:NSZeroRect];
    portControl.stringValue = @"22";
    [controls addObjectsFromArray:@[targetControl, portControl, usernameControl, hostKeyControl, expirationControl]];
    for (NSUInteger index = 0U; index < labels.count; ++index) {
        NSTextField *label = [NSTextField labelWithString:labels[index]];
        label.frame = NSMakeRect(0, 180 - (NSInteger)index * 34, 205, 24);
        controls[index].frame = NSMakeRect(210, 180 - (NSInteger)index * 34, 310, 24);
        [view addSubview:label];
        [view addSubview:controls[index]];
    }
    *action = actionControl;
    *target = targetControl;
    *port = portControl;
    *username = usernameControl;
    *hostKey = hostKeyControl;
    *expiration = expirationControl;
    return view;
}

int main(int argc, const char *argv[]) {
    (void)argv;
    @autoreleasepool {
        if (argc != 1 || !MOBAdminSelfAtExpectedPath() ||
            !MOBRootOwnedAncestors(MOBAdminExecutablePath) ||
            !MOBRootOwnedExecutable(MOBAdminExecutablePath) ||
            !MOBStableSignedCode(MOBAdminExecutablePath)) {
            return 70;
        }
        [NSApplication sharedApplication];
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"Monitor opaque broker role administration";
        alert.informativeText = [NSString stringWithFormat:@"Role: %@\nOperation: %@\nNo network connection is made.", MOBAdminRole, MOBAdminOperation];
        NSPopUpButton *action = nil;
        NSTextField *target = nil;
        NSTextField *port = nil;
        NSTextField *username = nil;
        NSTextField *hostKey = nil;
        NSTextField *expiration = nil;
        alert.accessoryView = MOBInputView(&action, &target, &port, &username, &hostKey, &expiration);
        [alert addButtonWithTitle:@"Continue"];
        [alert addButtonWithTitle:@"Cancel"];
        if ([alert runModal] != NSAlertFirstButtonReturn) {
            return 0;
        }
        MOBAdminAction selected = (MOBAdminAction)action.indexOfSelectedItem;
        BOOL success;
        NSData *publicEnrollment = nil;
        unsigned long long portValue = 0U;
        unsigned long long expirationValue = 0U;
        if (selected == MOBAdminActionRevoke) {
            success = MOBRevokeExactRole();
        } else {
            success = MOBParseUnsignedDecimal(port.stringValue, 65535U, &portValue) &&
                MOBParseUnsignedDecimal(expiration.stringValue, ULLONG_MAX, &expirationValue) &&
                MOBRootOwnedAncestors(MOBAdminBrokerPath) &&
                MOBProvision(
                    selected,
                    target.stringValue,
                    (NSInteger)portValue,
                    username.stringValue,
                    hostKey.stringValue,
                    expirationValue,
                    &publicEnrollment
                );
            if (success) {
                success = MOBSavePublicEnrollment(publicEnrollment);
                if (!success) {
                    (void)MOBRevokeExactRole();
                }
            }
        }
        MOBShowResult(success);
        return success ? 0 : 70;
    }
}
