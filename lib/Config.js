"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.Config = void 0;
var _lodash = require("lodash");
var _pathToRegexp = require("path-to-regexp");
var _net = _interopRequireDefault(require("net"));
var _cache = _interopRequireDefault(require("./cache"));
var _DatabaseController = _interopRequireDefault(require("./Controllers/DatabaseController"));
var _LoggerController = require("./Controllers/LoggerController");
var _package = require("../package.json");
var _Definitions = require("./Options/Definitions");
var _Parse = _interopRequireDefault(require("./cloud-code/Parse.Server"));
var _Deprecator = _interopRequireDefault(require("./Deprecator/Deprecator"));
var _Utils = _interopRequireDefault(require("./Utils"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// A Config object provides information about how a specific app is
// configured.
// mount is the URL for the root of the API; includes http, domain, etc.

function removeTrailingSlash(str) {
  if (!str) {
    return str;
  }
  if (str.endsWith('/')) {
    str = str.substring(0, str.length - 1);
  }
  return str;
}

/**
 * Config keys that need to be loaded asynchronously.
 */
const asyncKeys = ['publicServerURL'];
class Config {
  static get(applicationId, mount) {
    const cacheInfo = _cache.default.get(applicationId);
    if (!cacheInfo) {
      return;
    }
    const config = new Config();
    config.applicationId = applicationId;
    Object.keys(cacheInfo).forEach(key => {
      if (key != 'databaseController' && key != 'database') {
        config[key] = cacheInfo[key];
      }
    });
    // Always create a new database controller, as it holds request-scoped state such as the
    // transactional session; a request-scoped config in the cache has `database` instead of
    // `databaseController`
    const databaseController = cacheInfo.databaseController || cacheInfo.database;
    if (databaseController) {
      config.database = new _DatabaseController.default(databaseController.adapter, config);
    }
    config.mount = removeTrailingSlash(mount);
    config.generateSessionExpiresAt = config.generateSessionExpiresAt.bind(config);
    config.generateEmailVerifyTokenExpiresAt = config.generateEmailVerifyTokenExpiresAt.bind(config);
    config.version = _package.version;
    return config;
  }
  async loadKeys() {
    await Promise.all(asyncKeys.map(async key => {
      if (typeof this[`_${key}`] === 'function') {
        try {
          this[key] = await this[`_${key}`]();
        } catch (error) {
          throw new Error(`Failed to resolve async config key '${key}': ${error.message}`);
        }
      }
    }));
    const cachedConfig = _cache.default.get(this.appId);
    if (cachedConfig) {
      const updatedConfig = {
        ...cachedConfig
      };
      asyncKeys.forEach(key => {
        updatedConfig[key] = this[key];
      });
      _cache.default.put(this.appId, updatedConfig);
    }
  }
  static transformConfiguration(serverConfiguration) {
    for (const key of Object.keys(serverConfiguration)) {
      if (asyncKeys.includes(key) && typeof serverConfiguration[key] === 'function') {
        serverConfiguration[`_${key}`] = serverConfiguration[key];
        delete serverConfiguration[key];
      }
    }
  }
  static put(serverConfiguration) {
    Config.validateOptions(serverConfiguration);
    Config.validateControllers(serverConfiguration);
    if (serverConfiguration.routeAllowList) {
      serverConfiguration._routeAllowListRegex = serverConfiguration.routeAllowList.map(pattern => new RegExp('^' + pattern + '$'));
    }
    Config.transformConfiguration(serverConfiguration);
    _cache.default.put(serverConfiguration.appId, serverConfiguration);
    Config.setupPasswordValidator(serverConfiguration.passwordPolicy);
    return serverConfiguration;
  }
  static validateOptions({
    customPages,
    publicServerURL,
    revokeSessionOnPasswordReset,
    expireInactiveSessions,
    sessionLength,
    defaultLimit,
    maxLimit,
    accountLockout,
    passwordPolicy,
    masterKeyIps,
    masterKey,
    maintenanceKey,
    maintenanceKeyIps,
    readOnlyMasterKey,
    readOnlyMasterKeyIps,
    allowHeaders,
    idempotencyOptions,
    fileUpload,
    fileDownload,
    pages,
    security,
    enforcePrivateUsers,
    enableInsecureAuthAdapters,
    schema,
    requestKeywordDenylist,
    allowExpiredAuthDataToken,
    logLevels,
    rateLimit,
    databaseOptions,
    extendSessionOnUse,
    allowClientClassCreation,
    requestComplexity,
    liveQuery,
    routeAllowList,
    installation
  }) {
    if (masterKey === readOnlyMasterKey) {
      throw new Error('masterKey and readOnlyMasterKey should be different');
    }
    if (masterKey === maintenanceKey) {
      throw new Error('masterKey and maintenanceKey should be different');
    }
    this.validateAccountLockoutPolicy(accountLockout);
    this.validatePasswordPolicy(passwordPolicy);
    this.validateFileUploadOptions(fileUpload);
    if (fileDownload == null) {
      fileDownload = {};
      arguments[0].fileDownload = fileDownload;
    }
    this.validateFileDownloadOptions(fileDownload);
    if (typeof revokeSessionOnPasswordReset !== 'boolean') {
      throw 'revokeSessionOnPasswordReset must be a boolean value';
    }
    if (typeof extendSessionOnUse !== 'boolean') {
      throw 'extendSessionOnUse must be a boolean value';
    }
    this.validatePublicServerURL({
      publicServerURL
    });
    this.validateSessionConfiguration(sessionLength, expireInactiveSessions);
    this.validateIps('masterKeyIps', masterKeyIps);
    this.validateIps('maintenanceKeyIps', maintenanceKeyIps);
    this.validateIps('readOnlyMasterKeyIps', readOnlyMasterKeyIps);
    this.validateDefaultLimit(defaultLimit);
    this.validateMaxLimit(maxLimit);
    this.validateAllowHeaders(allowHeaders);
    this.validateIdempotencyOptions(idempotencyOptions);
    this.validatePagesOptions(pages);
    this.validateSecurityOptions(security);
    this.validateSchemaOptions(schema);
    this.validateEnforcePrivateUsers(enforcePrivateUsers);
    this.validateEnableInsecureAuthAdapters(enableInsecureAuthAdapters);
    this.validateAllowExpiredAuthDataToken(allowExpiredAuthDataToken);
    this.validateRequestKeywordDenylist(requestKeywordDenylist);
    this.validateRateLimit(rateLimit);
    this.validateLogLevels(logLevels);
    this.validateDatabaseOptions(databaseOptions);
    this.validateCustomPages(customPages);
    this.validateAllowClientClassCreation(allowClientClassCreation);
    this.validateRequestComplexity(requestComplexity);
    this.validateLiveQueryOptions(liveQuery);
    this.validateRouteAllowList(routeAllowList);
    this.validateInstallation(installation);
  }
  static validateCustomPages(customPages) {
    if (!customPages) {
      return;
    }
    if (Object.prototype.toString.call(customPages) !== '[object Object]') {
      throw Error('Parse Server option customPages must be an object.');
    }
  }
  static validateControllers({
    verifyUserEmails,
    userController,
    appName,
    publicServerURL,
    _publicServerURL,
    emailVerifyTokenValidityDuration,
    emailVerifyTokenReuseIfValid,
    emailVerifySuccessOnInvalidEmail
  }) {
    const emailAdapter = userController.adapter;
    if (verifyUserEmails) {
      this.validateEmailConfiguration({
        emailAdapter,
        appName,
        publicServerURL: publicServerURL || _publicServerURL,
        emailVerifyTokenValidityDuration,
        emailVerifyTokenReuseIfValid,
        emailVerifySuccessOnInvalidEmail
      });
    }
  }
  static validateRequestKeywordDenylist(requestKeywordDenylist) {
    if (requestKeywordDenylist === undefined) {
      requestKeywordDenylist = requestKeywordDenylist.default;
    } else if (!Array.isArray(requestKeywordDenylist)) {
      throw 'Parse Server option requestKeywordDenylist must be an array.';
    }
  }
  static validateEnforcePrivateUsers(enforcePrivateUsers) {
    if (typeof enforcePrivateUsers !== 'boolean') {
      throw 'Parse Server option enforcePrivateUsers must be a boolean.';
    }
  }
  static validateAllowExpiredAuthDataToken(allowExpiredAuthDataToken) {
    if (typeof allowExpiredAuthDataToken !== 'boolean') {
      throw 'Parse Server option allowExpiredAuthDataToken must be a boolean.';
    }
  }
  static validateAllowClientClassCreation(allowClientClassCreation) {
    if (typeof allowClientClassCreation !== 'boolean') {
      throw 'Parse Server option allowClientClassCreation must be a boolean.';
    }
  }
  static validateSecurityOptions(security) {
    if (Object.prototype.toString.call(security) !== '[object Object]') {
      throw 'Parse Server option security must be an object.';
    }
    if (security.enableCheck === undefined) {
      security.enableCheck = _Definitions.SecurityOptions.enableCheck.default;
    } else if (!(0, _lodash.isBoolean)(security.enableCheck)) {
      throw 'Parse Server option security.enableCheck must be a boolean.';
    }
    if (security.enableCheckLog === undefined) {
      security.enableCheckLog = _Definitions.SecurityOptions.enableCheckLog.default;
    } else if (!(0, _lodash.isBoolean)(security.enableCheckLog)) {
      throw 'Parse Server option security.enableCheckLog must be a boolean.';
    }
  }
  static validateSchemaOptions(schema) {
    if (!schema) {
      return;
    }
    if (Object.prototype.toString.call(schema) !== '[object Object]') {
      throw 'Parse Server option schema must be an object.';
    }
    if (schema.definitions === undefined) {
      schema.definitions = _Definitions.SchemaOptions.definitions.default;
    } else if (!Array.isArray(schema.definitions)) {
      throw 'Parse Server option schema.definitions must be an array.';
    }
    if (schema.strict === undefined) {
      schema.strict = _Definitions.SchemaOptions.strict.default;
    } else if (!(0, _lodash.isBoolean)(schema.strict)) {
      throw 'Parse Server option schema.strict must be a boolean.';
    }
    if (schema.deleteExtraFields === undefined) {
      schema.deleteExtraFields = _Definitions.SchemaOptions.deleteExtraFields.default;
    } else if (!(0, _lodash.isBoolean)(schema.deleteExtraFields)) {
      throw 'Parse Server option schema.deleteExtraFields must be a boolean.';
    }
    if (schema.recreateModifiedFields === undefined) {
      schema.recreateModifiedFields = _Definitions.SchemaOptions.recreateModifiedFields.default;
    } else if (!(0, _lodash.isBoolean)(schema.recreateModifiedFields)) {
      throw 'Parse Server option schema.recreateModifiedFields must be a boolean.';
    }
    if (schema.lockSchemas === undefined) {
      schema.lockSchemas = _Definitions.SchemaOptions.lockSchemas.default;
    } else if (!(0, _lodash.isBoolean)(schema.lockSchemas)) {
      throw 'Parse Server option schema.lockSchemas must be a boolean.';
    }
    if (schema.beforeMigration === undefined) {
      schema.beforeMigration = null;
    } else if (schema.beforeMigration !== null && typeof schema.beforeMigration !== 'function') {
      throw 'Parse Server option schema.beforeMigration must be a function.';
    }
    if (schema.afterMigration === undefined) {
      schema.afterMigration = null;
    } else if (schema.afterMigration !== null && typeof schema.afterMigration !== 'function') {
      throw 'Parse Server option schema.afterMigration must be a function.';
    }
  }
  static validatePagesOptions(pages) {
    if (Object.prototype.toString.call(pages) !== '[object Object]') {
      throw 'Parse Server option pages must be an object.';
    }
    if (pages.enableLocalization === undefined) {
      pages.enableLocalization = _Definitions.PagesOptions.enableLocalization.default;
    } else if (!(0, _lodash.isBoolean)(pages.enableLocalization)) {
      throw 'Parse Server option pages.enableLocalization must be a boolean.';
    }
    if (pages.localizationJsonPath === undefined) {
      pages.localizationJsonPath = _Definitions.PagesOptions.localizationJsonPath.default;
    } else if (!(0, _lodash.isString)(pages.localizationJsonPath)) {
      throw 'Parse Server option pages.localizationJsonPath must be a string.';
    }
    if (pages.localizationFallbackLocale === undefined) {
      pages.localizationFallbackLocale = _Definitions.PagesOptions.localizationFallbackLocale.default;
    } else if (!(0, _lodash.isString)(pages.localizationFallbackLocale)) {
      throw 'Parse Server option pages.localizationFallbackLocale must be a string.';
    }
    if (pages.placeholders === undefined) {
      pages.placeholders = _Definitions.PagesOptions.placeholders.default;
    } else if (Object.prototype.toString.call(pages.placeholders) !== '[object Object]' && typeof pages.placeholders !== 'function') {
      throw 'Parse Server option pages.placeholders must be an object or a function.';
    }
    if (pages.forceRedirect === undefined) {
      pages.forceRedirect = _Definitions.PagesOptions.forceRedirect.default;
    } else if (!(0, _lodash.isBoolean)(pages.forceRedirect)) {
      throw 'Parse Server option pages.forceRedirect must be a boolean.';
    }
    if (pages.pagesPath !== undefined && !(0, _lodash.isString)(pages.pagesPath)) {
      throw 'Parse Server option pages.pagesPath must be a string.';
    }
    if (pages.pagesEndpoint === undefined) {
      pages.pagesEndpoint = _Definitions.PagesOptions.pagesEndpoint.default;
    } else if (!(0, _lodash.isString)(pages.pagesEndpoint)) {
      throw 'Parse Server option pages.pagesEndpoint must be a string.';
    }
    if (pages.customUrls === undefined) {
      pages.customUrls = _Definitions.PagesOptions.customUrls.default;
    } else if (Object.prototype.toString.call(pages.customUrls) !== '[object Object]') {
      throw 'Parse Server option pages.customUrls must be an object.';
    }
    if (pages.customRoutes === undefined) {
      pages.customRoutes = _Definitions.PagesOptions.customRoutes.default;
    } else if (!Array.isArray(pages.customRoutes)) {
      throw 'Parse Server option pages.customRoutes must be an array.';
    }
    if (pages.encodePageParamHeaders === undefined) {
      pages.encodePageParamHeaders = _Definitions.PagesOptions.encodePageParamHeaders.default;
    } else if (!(0, _lodash.isBoolean)(pages.encodePageParamHeaders)) {
      throw 'Parse Server option pages.encodePageParamHeaders must be a boolean.';
    }
  }
  static validateIdempotencyOptions(idempotencyOptions) {
    if (!idempotencyOptions) {
      return;
    }
    if (idempotencyOptions.ttl === undefined) {
      idempotencyOptions.ttl = _Definitions.IdempotencyOptions.ttl.default;
    } else if (!isNaN(idempotencyOptions.ttl) && idempotencyOptions.ttl <= 0) {
      throw 'idempotency TTL value must be greater than 0 seconds';
    } else if (isNaN(idempotencyOptions.ttl)) {
      throw 'idempotency TTL value must be a number';
    }
    if (!idempotencyOptions.paths) {
      idempotencyOptions.paths = _Definitions.IdempotencyOptions.paths.default;
    } else if (!Array.isArray(idempotencyOptions.paths)) {
      throw 'idempotency paths must be of an array of strings';
    }
  }
  static validateAccountLockoutPolicy(accountLockout) {
    if (accountLockout) {
      if (typeof accountLockout.duration !== 'number' || accountLockout.duration <= 0 || accountLockout.duration > 99999) {
        throw 'Account lockout duration should be greater than 0 and less than 100000';
      }
      if (!Number.isInteger(accountLockout.threshold) || accountLockout.threshold < 1 || accountLockout.threshold > 999) {
        throw 'Account lockout threshold should be an integer greater than 0 and less than 1000';
      }
      if (accountLockout.unlockOnPasswordReset === undefined) {
        accountLockout.unlockOnPasswordReset = _Definitions.AccountLockoutOptions.unlockOnPasswordReset.default;
      } else if (!(0, _lodash.isBoolean)(accountLockout.unlockOnPasswordReset)) {
        throw 'Parse Server option accountLockout.unlockOnPasswordReset must be a boolean.';
      }
    }
  }
  static validatePasswordPolicy(passwordPolicy) {
    if (passwordPolicy) {
      if (passwordPolicy.maxPasswordAge !== undefined && (typeof passwordPolicy.maxPasswordAge !== 'number' || passwordPolicy.maxPasswordAge < 0)) {
        throw 'passwordPolicy.maxPasswordAge must be a positive number';
      }
      if (passwordPolicy.resetTokenValidityDuration !== undefined && (typeof passwordPolicy.resetTokenValidityDuration !== 'number' || passwordPolicy.resetTokenValidityDuration <= 0)) {
        throw 'passwordPolicy.resetTokenValidityDuration must be a positive number';
      }
      if (passwordPolicy.validatorPattern) {
        if (typeof passwordPolicy.validatorPattern === 'string') {
          passwordPolicy.validatorPattern = new RegExp(passwordPolicy.validatorPattern);
        } else if (!_Utils.default.isRegExp(passwordPolicy.validatorPattern)) {
          throw 'passwordPolicy.validatorPattern must be a regex string or RegExp object.';
        }
      }
      if (passwordPolicy.validatorCallback && typeof passwordPolicy.validatorCallback !== 'function') {
        throw 'passwordPolicy.validatorCallback must be a function.';
      }
      if (passwordPolicy.doNotAllowUsername && typeof passwordPolicy.doNotAllowUsername !== 'boolean') {
        throw 'passwordPolicy.doNotAllowUsername must be a boolean value.';
      }
      if (passwordPolicy.maxPasswordHistory && (!Number.isInteger(passwordPolicy.maxPasswordHistory) || passwordPolicy.maxPasswordHistory <= 0 || passwordPolicy.maxPasswordHistory > 20)) {
        throw 'passwordPolicy.maxPasswordHistory must be an integer ranging 0 - 20';
      }
      if (passwordPolicy.resetTokenReuseIfValid && typeof passwordPolicy.resetTokenReuseIfValid !== 'boolean') {
        throw 'resetTokenReuseIfValid must be a boolean value';
      }
      if (passwordPolicy.resetTokenReuseIfValid && !passwordPolicy.resetTokenValidityDuration) {
        throw 'You cannot use resetTokenReuseIfValid without resetTokenValidityDuration';
      }
      if (passwordPolicy.resetPasswordSuccessOnInvalidEmail !== undefined && typeof passwordPolicy.resetPasswordSuccessOnInvalidEmail !== 'boolean') {
        throw 'resetPasswordSuccessOnInvalidEmail must be a boolean value';
      }
    }
  }

  // if the passwordPolicy.validatorPattern is configured then setup a callback to process the pattern
  static setupPasswordValidator(passwordPolicy) {
    if (passwordPolicy && passwordPolicy.validatorPattern) {
      passwordPolicy.patternValidator = value => {
        return passwordPolicy.validatorPattern.test(value);
      };
    }
  }
  static validatePublicServerURL({
    publicServerURL,
    required = false
  }) {
    if (!publicServerURL) {
      if (!required) {
        return;
      }
      throw 'The option publicServerURL is required.';
    }
    const type = typeof publicServerURL;
    if (type === 'string') {
      if (!publicServerURL.startsWith('http://') && !publicServerURL.startsWith('https://')) {
        throw 'The option publicServerURL must be a valid URL starting with http:// or https://.';
      }
      return;
    }
    if (type === 'function') {
      return;
    }
    throw `The option publicServerURL must be a string or function, but got ${type}.`;
  }
  static validateEmailConfiguration({
    emailAdapter,
    appName,
    publicServerURL,
    emailVerifyTokenValidityDuration,
    emailVerifyTokenReuseIfValid,
    emailVerifySuccessOnInvalidEmail
  }) {
    if (!emailAdapter) {
      throw 'An emailAdapter is required for e-mail verification and password resets.';
    }
    if (typeof appName !== 'string') {
      throw 'An app name is required for e-mail verification and password resets.';
    }
    this.validatePublicServerURL({
      publicServerURL,
      required: true
    });
    if (emailVerifyTokenValidityDuration) {
      if (isNaN(emailVerifyTokenValidityDuration)) {
        throw 'Email verify token validity duration must be a valid number.';
      } else if (emailVerifyTokenValidityDuration <= 0) {
        throw 'Email verify token validity duration must be a value greater than 0.';
      }
    }
    if (emailVerifyTokenReuseIfValid && typeof emailVerifyTokenReuseIfValid !== 'boolean') {
      throw 'emailVerifyTokenReuseIfValid must be a boolean value';
    }
    if (emailVerifyTokenReuseIfValid && !emailVerifyTokenValidityDuration) {
      throw 'You cannot use emailVerifyTokenReuseIfValid without emailVerifyTokenValidityDuration';
    }
    if (emailVerifySuccessOnInvalidEmail !== undefined && typeof emailVerifySuccessOnInvalidEmail !== 'boolean') {
      throw 'emailVerifySuccessOnInvalidEmail must be a boolean value';
    }
  }
  static validateFileUploadOptions(fileUpload) {
    try {
      if (fileUpload == null || typeof fileUpload !== 'object' || Array.isArray(fileUpload)) {
        throw 'fileUpload must be an object value.';
      }
    } catch (e) {
      if (e instanceof ReferenceError) {
        return;
      }
      throw e;
    }
    if (fileUpload.enableForAnonymousUser === undefined) {
      fileUpload.enableForAnonymousUser = _Definitions.FileUploadOptions.enableForAnonymousUser.default;
    } else if (typeof fileUpload.enableForAnonymousUser !== 'boolean') {
      throw 'fileUpload.enableForAnonymousUser must be a boolean value.';
    }
    if (fileUpload.enableForPublic === undefined) {
      fileUpload.enableForPublic = _Definitions.FileUploadOptions.enableForPublic.default;
    } else if (typeof fileUpload.enableForPublic !== 'boolean') {
      throw 'fileUpload.enableForPublic must be a boolean value.';
    }
    if (fileUpload.enableForAuthenticatedUser === undefined) {
      fileUpload.enableForAuthenticatedUser = _Definitions.FileUploadOptions.enableForAuthenticatedUser.default;
    } else if (typeof fileUpload.enableForAuthenticatedUser !== 'boolean') {
      throw 'fileUpload.enableForAuthenticatedUser must be a boolean value.';
    }
    if (fileUpload.fileExtensions === undefined) {
      fileUpload.fileExtensions = _Definitions.FileUploadOptions.fileExtensions.default;
    } else if (!Array.isArray(fileUpload.fileExtensions)) {
      throw 'fileUpload.fileExtensions must be an array.';
    }
    if (fileUpload.allowedFileUrlDomains === undefined) {
      fileUpload.allowedFileUrlDomains = _Definitions.FileUploadOptions.allowedFileUrlDomains.default;
    } else if (!Array.isArray(fileUpload.allowedFileUrlDomains)) {
      throw 'fileUpload.allowedFileUrlDomains must be an array.';
    } else {
      for (const domain of fileUpload.allowedFileUrlDomains) {
        if (typeof domain !== 'string' || domain === '') {
          throw 'fileUpload.allowedFileUrlDomains must contain only non-empty strings.';
        }
      }
    }
  }
  static validateFileDownloadOptions(fileDownload) {
    try {
      if (fileDownload == null || typeof fileDownload !== 'object' || Array.isArray(fileDownload)) {
        throw 'fileDownload must be an object value.';
      }
    } catch (e) {
      if (e instanceof ReferenceError) {
        return;
      }
      throw e;
    }
    if (fileDownload.enableForAnonymousUser === undefined) {
      fileDownload.enableForAnonymousUser = _Definitions.FileDownloadOptions.enableForAnonymousUser.default;
    } else if (typeof fileDownload.enableForAnonymousUser !== 'boolean') {
      throw 'fileDownload.enableForAnonymousUser must be a boolean value.';
    }
    if (fileDownload.enableForPublic === undefined) {
      fileDownload.enableForPublic = _Definitions.FileDownloadOptions.enableForPublic.default;
    } else if (typeof fileDownload.enableForPublic !== 'boolean') {
      throw 'fileDownload.enableForPublic must be a boolean value.';
    }
    if (fileDownload.enableForAuthenticatedUser === undefined) {
      fileDownload.enableForAuthenticatedUser = _Definitions.FileDownloadOptions.enableForAuthenticatedUser.default;
    } else if (typeof fileDownload.enableForAuthenticatedUser !== 'boolean') {
      throw 'fileDownload.enableForAuthenticatedUser must be a boolean value.';
    }
  }
  static validateIps(field, masterKeyIps) {
    for (let ip of masterKeyIps) {
      if (ip.includes('/')) {
        ip = ip.split('/')[0];
      }
      if (!_net.default.isIP(ip)) {
        throw `The Parse Server option "${field}" contains an invalid IP address "${ip}".`;
      }
    }
  }
  static validateEnableInsecureAuthAdapters(enableInsecureAuthAdapters) {
    if (enableInsecureAuthAdapters && typeof enableInsecureAuthAdapters !== 'boolean') {
      throw 'Parse Server option enableInsecureAuthAdapters must be a boolean.';
    }
    if (enableInsecureAuthAdapters) {
      _Deprecator.default.logRuntimeDeprecation({
        usage: 'insecure adapter'
      });
    }
  }
  get mount() {
    var mount = this._mount;
    if (this.publicServerURL) {
      mount = this.publicServerURL;
    }
    return mount;
  }
  set mount(newValue) {
    this._mount = newValue;
  }
  static validateSessionConfiguration(sessionLength, expireInactiveSessions) {
    if (expireInactiveSessions) {
      if (isNaN(sessionLength)) {
        throw 'Session length must be a valid number.';
      } else if (sessionLength <= 0) {
        throw 'Session length must be a value greater than 0.';
      }
    }
  }
  static validateDefaultLimit(defaultLimit) {
    if (defaultLimit == null) {
      defaultLimit = _Definitions.ParseServerOptions.defaultLimit.default;
    }
    if (typeof defaultLimit !== 'number') {
      throw 'Default limit must be a number.';
    }
    if (defaultLimit <= 0) {
      throw 'Default limit must be a value greater than 0.';
    }
  }
  static validateMaxLimit(maxLimit) {
    if (maxLimit <= 0) {
      throw 'Max limit must be a value greater than 0.';
    }
  }
  static validateRequestComplexity(requestComplexity) {
    if (requestComplexity == null) {
      return;
    }
    if (typeof requestComplexity !== 'object' || Array.isArray(requestComplexity)) {
      throw new Error('requestComplexity must be an object.');
    }
    const validKeys = Object.keys(_Definitions.RequestComplexityOptions);
    for (const key of Object.keys(requestComplexity)) {
      if (!validKeys.includes(key)) {
        throw new Error(`requestComplexity contains unknown property '${key}'.`);
      }
    }
    for (const key of validKeys) {
      if (requestComplexity[key] !== undefined) {
        const value = requestComplexity[key];
        const def = _Definitions.RequestComplexityOptions[key];
        if (typeof def.default === 'boolean') {
          if (typeof value !== 'boolean') {
            throw new Error(`requestComplexity.${key} must be a boolean.`);
          }
        } else if (!Number.isInteger(value) || value < 1 && value !== -1) {
          throw new Error(`requestComplexity.${key} must be a positive integer or -1 to disable.`);
        }
      } else {
        requestComplexity[key] = _Definitions.RequestComplexityOptions[key].default;
      }
    }
  }
  static validateInstallation(installation) {
    if (installation === undefined) {
      return;
    }
    if (typeof installation !== 'object' || Array.isArray(installation) || installation === null) {
      throw 'installation must be an object.';
    }
    const validKeys = ['duplicateDeviceTokenActionEnforceAuth', 'duplicateDeviceTokenAction', 'duplicateDeviceTokenMergePriority'];
    for (const key of Object.keys(installation)) {
      if (!validKeys.includes(key)) {
        throw `installation contains unknown property '${key}'.`;
      }
    }
    if (installation.duplicateDeviceTokenActionEnforceAuth === undefined) {
      installation.duplicateDeviceTokenActionEnforceAuth = _Definitions.InstallationOptions.duplicateDeviceTokenActionEnforceAuth.default;
    } else if (typeof installation.duplicateDeviceTokenActionEnforceAuth !== 'boolean') {
      throw 'installation.duplicateDeviceTokenActionEnforceAuth must be a boolean.';
    }
    const validActions = ['delete', 'update'];
    if (installation.duplicateDeviceTokenAction === undefined) {
      installation.duplicateDeviceTokenAction = _Definitions.InstallationOptions.duplicateDeviceTokenAction.default;
    } else if (!validActions.includes(installation.duplicateDeviceTokenAction)) {
      throw "installation.duplicateDeviceTokenAction must be one of: 'delete', 'update'.";
    }
    const validPriorities = ['deviceToken', 'installationId'];
    if (installation.duplicateDeviceTokenMergePriority === undefined) {
      installation.duplicateDeviceTokenMergePriority = _Definitions.InstallationOptions.duplicateDeviceTokenMergePriority.default;
    } else if (!validPriorities.includes(installation.duplicateDeviceTokenMergePriority)) {
      throw "installation.duplicateDeviceTokenMergePriority must be one of: 'deviceToken', 'installationId'.";
    }
  }
  static validateAllowHeaders(allowHeaders) {
    if (![null, undefined].includes(allowHeaders)) {
      if (Array.isArray(allowHeaders)) {
        allowHeaders.forEach(header => {
          if (typeof header !== 'string') {
            throw 'Allow headers must only contain strings';
          } else if (!header.trim().length) {
            throw 'Allow headers must not contain empty strings';
          }
        });
      } else {
        throw 'Allow headers must be an array';
      }
    }
  }
  static validateLogLevels(logLevels) {
    for (const key of Object.keys(_Definitions.LogLevels)) {
      if (logLevels[key]) {
        if (_LoggerController.logLevels.indexOf(logLevels[key]) === -1) {
          throw `'${key}' must be one of ${JSON.stringify(_LoggerController.logLevels)}`;
        }
      } else {
        logLevels[key] = _Definitions.LogLevels[key].default;
      }
    }
  }
  static validateDatabaseOptions(databaseOptions) {
    if (databaseOptions == undefined) {
      return;
    }
    if (Object.prototype.toString.call(databaseOptions) !== '[object Object]') {
      throw `databaseOptions must be an object`;
    }
    if (databaseOptions.enableSchemaHooks === undefined) {
      databaseOptions.enableSchemaHooks = _Definitions.DatabaseOptions.enableSchemaHooks.default;
    } else if (typeof databaseOptions.enableSchemaHooks !== 'boolean') {
      throw `databaseOptions.enableSchemaHooks must be a boolean`;
    }
    if (databaseOptions.schemaCacheTtl === undefined) {
      databaseOptions.schemaCacheTtl = _Definitions.DatabaseOptions.schemaCacheTtl.default;
    } else if (typeof databaseOptions.schemaCacheTtl !== 'number') {
      throw `databaseOptions.schemaCacheTtl must be a number`;
    }
    if (databaseOptions.allowPublicExplain === undefined) {
      databaseOptions.allowPublicExplain = _Definitions.DatabaseOptions.allowPublicExplain.default;
    } else if (typeof databaseOptions.allowPublicExplain !== 'boolean') {
      throw `Parse Server option 'databaseOptions.allowPublicExplain' must be a boolean.`;
    }
  }
  static validateLiveQueryOptions(liveQuery) {
    if (liveQuery == undefined) {
      return;
    }
    if (liveQuery.regexTimeout === undefined) {
      liveQuery.regexTimeout = _Definitions.LiveQueryOptions.regexTimeout.default;
    } else if (typeof liveQuery.regexTimeout !== 'number') {
      throw `liveQuery.regexTimeout must be a number`;
    }
  }
  static validateRouteAllowList(routeAllowList) {
    if (routeAllowList === undefined || routeAllowList === null) {
      return;
    }
    if (!Array.isArray(routeAllowList)) {
      throw 'Parse Server option routeAllowList must be an array of strings.';
    }
    for (const pattern of routeAllowList) {
      if (typeof pattern !== 'string') {
        throw `Parse Server option routeAllowList contains a non-string value.`;
      }
      try {
        new RegExp('^' + pattern + '$');
      } catch {
        throw `Parse Server option routeAllowList contains an invalid regex pattern: "${pattern}".`;
      }
    }
  }
  static validateRateLimit(rateLimit) {
    if (!rateLimit) {
      return;
    }
    if (Object.prototype.toString.call(rateLimit) !== '[object Object]' && !Array.isArray(rateLimit)) {
      throw `rateLimit must be an array or object`;
    }
    const options = Array.isArray(rateLimit) ? rateLimit : [rateLimit];
    for (const option of options) {
      if (Object.prototype.toString.call(option) !== '[object Object]') {
        throw `rateLimit must be an array of objects`;
      }
      if (option.requestPath == null) {
        throw `rateLimit.requestPath must be defined`;
      }
      if (typeof option.requestPath !== 'string') {
        throw `rateLimit.requestPath must be a string`;
      }

      // Validate that the path is valid path-to-regexp syntax
      try {
        (0, _pathToRegexp.pathToRegexp)(option.requestPath);
      } catch (error) {
        throw `rateLimit.requestPath "${option.requestPath}" is not valid: ${error.message}`;
      }
      if (option.requestTimeWindow == null) {
        throw `rateLimit.requestTimeWindow must be defined`;
      }
      if (typeof option.requestTimeWindow !== 'number') {
        throw `rateLimit.requestTimeWindow must be a number`;
      }
      if (option.includeInternalRequests && typeof option.includeInternalRequests !== 'boolean') {
        throw `rateLimit.includeInternalRequests must be a boolean`;
      }
      if (option.requestCount == null) {
        throw `rateLimit.requestCount must be defined`;
      }
      if (typeof option.requestCount !== 'number') {
        throw `rateLimit.requestCount must be a number`;
      }
      if (option.errorResponseMessage && typeof option.errorResponseMessage !== 'string') {
        throw `rateLimit.errorResponseMessage must be a string`;
      }
      const options = Object.keys(_Parse.default.RateLimitZone);
      if (option.zone && !options.includes(option.zone)) {
        const formatter = new Intl.ListFormat('en', {
          style: 'short',
          type: 'disjunction'
        });
        throw `rateLimit.zone must be one of ${formatter.format(options)}`;
      }
    }
  }
  generateEmailVerifyTokenExpiresAt() {
    if (!this.verifyUserEmails || !this.emailVerifyTokenValidityDuration) {
      return undefined;
    }
    var now = new Date();
    return new Date(now.getTime() + this.emailVerifyTokenValidityDuration * 1000);
  }
  generatePasswordResetTokenExpiresAt() {
    if (!this.passwordPolicy || !this.passwordPolicy.resetTokenValidityDuration) {
      return undefined;
    }
    const now = new Date();
    return new Date(now.getTime() + this.passwordPolicy.resetTokenValidityDuration * 1000);
  }
  generateSessionExpiresAt() {
    if (!this.expireInactiveSessions) {
      return undefined;
    }
    var now = new Date();
    return new Date(now.getTime() + this.sessionLength * 1000);
  }
  unregisterRateLimiters() {
    let i = this.rateLimits?.length;
    while (i--) {
      const limit = this.rateLimits[i];
      if (limit.cloud) {
        this.rateLimits.splice(i, 1);
      }
    }
  }
  get invalidLinkURL() {
    return this.customPages.invalidLink || `${this.publicServerURL}/apps/invalid_link.html`;
  }
  get invalidVerificationLinkURL() {
    return this.customPages.invalidVerificationLink || `${this.publicServerURL}/apps/invalid_verification_link.html`;
  }
  get linkSendSuccessURL() {
    return this.customPages.linkSendSuccess || `${this.publicServerURL}/apps/link_send_success.html`;
  }
  get linkSendFailURL() {
    return this.customPages.linkSendFail || `${this.publicServerURL}/apps/link_send_fail.html`;
  }
  get verifyEmailSuccessURL() {
    return this.customPages.verifyEmailSuccess || `${this.publicServerURL}/apps/verify_email_success.html`;
  }
  get choosePasswordURL() {
    return this.customPages.choosePassword || `${this.publicServerURL}/apps/choose_password`;
  }
  get requestResetPasswordURL() {
    return `${this.publicServerURL}/${this.pagesEndpoint}/${this.applicationId}/request_password_reset`;
  }
  get passwordResetSuccessURL() {
    return this.customPages.passwordResetSuccess || `${this.publicServerURL}/apps/password_reset_success.html`;
  }
  get parseFrameURL() {
    return this.customPages.parseFrameURL;
  }
  get verifyEmailURL() {
    return `${this.publicServerURL}/${this.pagesEndpoint}/${this.applicationId}/verify_email`;
  }
  async loadMasterKey() {
    if (typeof this.masterKey === 'function') {
      const ttlIsEmpty = !this.masterKeyTtl;
      const isExpired = this.masterKeyCache?.expiresAt && this.masterKeyCache.expiresAt < new Date();
      if ((!isExpired || ttlIsEmpty) && this.masterKeyCache?.masterKey) {
        return this.masterKeyCache.masterKey;
      }
      const masterKey = await this.masterKey();
      const expiresAt = this.masterKeyTtl ? new Date(Date.now() + 1000 * this.masterKeyTtl) : null;
      this.masterKeyCache = {
        masterKey,
        expiresAt
      };
      // Update only the cached server config, as this config is request-scoped
      const serverConfig = _cache.default.get(this.applicationId);
      if (serverConfig) {
        serverConfig.masterKeyCache = this.masterKeyCache;
      }
      return this.masterKeyCache.masterKey;
    }
    return this.masterKey;
  }
  get pagesEndpoint() {
    return this.pages && this.pages.pagesEndpoint ? this.pages.pagesEndpoint : 'apps';
  }
}
exports.Config = Config;
var _default = exports.default = Config;
module.exports = Config;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbG9kYXNoIiwicmVxdWlyZSIsIl9wYXRoVG9SZWdleHAiLCJfbmV0IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsIl9jYWNoZSIsIl9EYXRhYmFzZUNvbnRyb2xsZXIiLCJfTG9nZ2VyQ29udHJvbGxlciIsIl9wYWNrYWdlIiwiX0RlZmluaXRpb25zIiwiX1BhcnNlIiwiX0RlcHJlY2F0b3IiLCJfVXRpbHMiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJyZW1vdmVUcmFpbGluZ1NsYXNoIiwic3RyIiwiZW5kc1dpdGgiLCJzdWJzdHJpbmciLCJsZW5ndGgiLCJhc3luY0tleXMiLCJDb25maWciLCJnZXQiLCJhcHBsaWNhdGlvbklkIiwibW91bnQiLCJjYWNoZUluZm8iLCJBcHBDYWNoZSIsImNvbmZpZyIsIk9iamVjdCIsImtleXMiLCJmb3JFYWNoIiwia2V5IiwiZGF0YWJhc2VDb250cm9sbGVyIiwiZGF0YWJhc2UiLCJEYXRhYmFzZUNvbnRyb2xsZXIiLCJhZGFwdGVyIiwiZ2VuZXJhdGVTZXNzaW9uRXhwaXJlc0F0IiwiYmluZCIsImdlbmVyYXRlRW1haWxWZXJpZnlUb2tlbkV4cGlyZXNBdCIsInZlcnNpb24iLCJsb2FkS2V5cyIsIlByb21pc2UiLCJhbGwiLCJtYXAiLCJlcnJvciIsIkVycm9yIiwibWVzc2FnZSIsImNhY2hlZENvbmZpZyIsImFwcElkIiwidXBkYXRlZENvbmZpZyIsInB1dCIsInRyYW5zZm9ybUNvbmZpZ3VyYXRpb24iLCJzZXJ2ZXJDb25maWd1cmF0aW9uIiwiaW5jbHVkZXMiLCJ2YWxpZGF0ZU9wdGlvbnMiLCJ2YWxpZGF0ZUNvbnRyb2xsZXJzIiwicm91dGVBbGxvd0xpc3QiLCJfcm91dGVBbGxvd0xpc3RSZWdleCIsInBhdHRlcm4iLCJSZWdFeHAiLCJzZXR1cFBhc3N3b3JkVmFsaWRhdG9yIiwicGFzc3dvcmRQb2xpY3kiLCJjdXN0b21QYWdlcyIsInB1YmxpY1NlcnZlclVSTCIsInJldm9rZVNlc3Npb25PblBhc3N3b3JkUmVzZXQiLCJleHBpcmVJbmFjdGl2ZVNlc3Npb25zIiwic2Vzc2lvbkxlbmd0aCIsImRlZmF1bHRMaW1pdCIsIm1heExpbWl0IiwiYWNjb3VudExvY2tvdXQiLCJtYXN0ZXJLZXlJcHMiLCJtYXN0ZXJLZXkiLCJtYWludGVuYW5jZUtleSIsIm1haW50ZW5hbmNlS2V5SXBzIiwicmVhZE9ubHlNYXN0ZXJLZXkiLCJyZWFkT25seU1hc3RlcktleUlwcyIsImFsbG93SGVhZGVycyIsImlkZW1wb3RlbmN5T3B0aW9ucyIsImZpbGVVcGxvYWQiLCJmaWxlRG93bmxvYWQiLCJwYWdlcyIsInNlY3VyaXR5IiwiZW5mb3JjZVByaXZhdGVVc2VycyIsImVuYWJsZUluc2VjdXJlQXV0aEFkYXB0ZXJzIiwic2NoZW1hIiwicmVxdWVzdEtleXdvcmREZW55bGlzdCIsImFsbG93RXhwaXJlZEF1dGhEYXRhVG9rZW4iLCJsb2dMZXZlbHMiLCJyYXRlTGltaXQiLCJkYXRhYmFzZU9wdGlvbnMiLCJleHRlbmRTZXNzaW9uT25Vc2UiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJyZXF1ZXN0Q29tcGxleGl0eSIsImxpdmVRdWVyeSIsImluc3RhbGxhdGlvbiIsInZhbGlkYXRlQWNjb3VudExvY2tvdXRQb2xpY3kiLCJ2YWxpZGF0ZVBhc3N3b3JkUG9saWN5IiwidmFsaWRhdGVGaWxlVXBsb2FkT3B0aW9ucyIsImFyZ3VtZW50cyIsInZhbGlkYXRlRmlsZURvd25sb2FkT3B0aW9ucyIsInZhbGlkYXRlUHVibGljU2VydmVyVVJMIiwidmFsaWRhdGVTZXNzaW9uQ29uZmlndXJhdGlvbiIsInZhbGlkYXRlSXBzIiwidmFsaWRhdGVEZWZhdWx0TGltaXQiLCJ2YWxpZGF0ZU1heExpbWl0IiwidmFsaWRhdGVBbGxvd0hlYWRlcnMiLCJ2YWxpZGF0ZUlkZW1wb3RlbmN5T3B0aW9ucyIsInZhbGlkYXRlUGFnZXNPcHRpb25zIiwidmFsaWRhdGVTZWN1cml0eU9wdGlvbnMiLCJ2YWxpZGF0ZVNjaGVtYU9wdGlvbnMiLCJ2YWxpZGF0ZUVuZm9yY2VQcml2YXRlVXNlcnMiLCJ2YWxpZGF0ZUVuYWJsZUluc2VjdXJlQXV0aEFkYXB0ZXJzIiwidmFsaWRhdGVBbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuIiwidmFsaWRhdGVSZXF1ZXN0S2V5d29yZERlbnlsaXN0IiwidmFsaWRhdGVSYXRlTGltaXQiLCJ2YWxpZGF0ZUxvZ0xldmVscyIsInZhbGlkYXRlRGF0YWJhc2VPcHRpb25zIiwidmFsaWRhdGVDdXN0b21QYWdlcyIsInZhbGlkYXRlQWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIiwidmFsaWRhdGVSZXF1ZXN0Q29tcGxleGl0eSIsInZhbGlkYXRlTGl2ZVF1ZXJ5T3B0aW9ucyIsInZhbGlkYXRlUm91dGVBbGxvd0xpc3QiLCJ2YWxpZGF0ZUluc3RhbGxhdGlvbiIsInByb3RvdHlwZSIsInRvU3RyaW5nIiwiY2FsbCIsInZlcmlmeVVzZXJFbWFpbHMiLCJ1c2VyQ29udHJvbGxlciIsImFwcE5hbWUiLCJfcHVibGljU2VydmVyVVJMIiwiZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24iLCJlbWFpbFZlcmlmeVRva2VuUmV1c2VJZlZhbGlkIiwiZW1haWxWZXJpZnlTdWNjZXNzT25JbnZhbGlkRW1haWwiLCJlbWFpbEFkYXB0ZXIiLCJ2YWxpZGF0ZUVtYWlsQ29uZmlndXJhdGlvbiIsInVuZGVmaW5lZCIsIkFycmF5IiwiaXNBcnJheSIsImVuYWJsZUNoZWNrIiwiU2VjdXJpdHlPcHRpb25zIiwiaXNCb29sZWFuIiwiZW5hYmxlQ2hlY2tMb2ciLCJkZWZpbml0aW9ucyIsIlNjaGVtYU9wdGlvbnMiLCJzdHJpY3QiLCJkZWxldGVFeHRyYUZpZWxkcyIsInJlY3JlYXRlTW9kaWZpZWRGaWVsZHMiLCJsb2NrU2NoZW1hcyIsImJlZm9yZU1pZ3JhdGlvbiIsImFmdGVyTWlncmF0aW9uIiwiZW5hYmxlTG9jYWxpemF0aW9uIiwiUGFnZXNPcHRpb25zIiwibG9jYWxpemF0aW9uSnNvblBhdGgiLCJpc1N0cmluZyIsImxvY2FsaXphdGlvbkZhbGxiYWNrTG9jYWxlIiwicGxhY2Vob2xkZXJzIiwiZm9yY2VSZWRpcmVjdCIsInBhZ2VzUGF0aCIsInBhZ2VzRW5kcG9pbnQiLCJjdXN0b21VcmxzIiwiY3VzdG9tUm91dGVzIiwiZW5jb2RlUGFnZVBhcmFtSGVhZGVycyIsInR0bCIsIklkZW1wb3RlbmN5T3B0aW9ucyIsImlzTmFOIiwicGF0aHMiLCJkdXJhdGlvbiIsIk51bWJlciIsImlzSW50ZWdlciIsInRocmVzaG9sZCIsInVubG9ja09uUGFzc3dvcmRSZXNldCIsIkFjY291bnRMb2Nrb3V0T3B0aW9ucyIsIm1heFBhc3N3b3JkQWdlIiwicmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb24iLCJ2YWxpZGF0b3JQYXR0ZXJuIiwiVXRpbHMiLCJpc1JlZ0V4cCIsInZhbGlkYXRvckNhbGxiYWNrIiwiZG9Ob3RBbGxvd1VzZXJuYW1lIiwibWF4UGFzc3dvcmRIaXN0b3J5IiwicmVzZXRUb2tlblJldXNlSWZWYWxpZCIsInJlc2V0UGFzc3dvcmRTdWNjZXNzT25JbnZhbGlkRW1haWwiLCJwYXR0ZXJuVmFsaWRhdG9yIiwidmFsdWUiLCJ0ZXN0IiwicmVxdWlyZWQiLCJ0eXBlIiwic3RhcnRzV2l0aCIsIlJlZmVyZW5jZUVycm9yIiwiZW5hYmxlRm9yQW5vbnltb3VzVXNlciIsIkZpbGVVcGxvYWRPcHRpb25zIiwiZW5hYmxlRm9yUHVibGljIiwiZW5hYmxlRm9yQXV0aGVudGljYXRlZFVzZXIiLCJmaWxlRXh0ZW5zaW9ucyIsImFsbG93ZWRGaWxlVXJsRG9tYWlucyIsImRvbWFpbiIsIkZpbGVEb3dubG9hZE9wdGlvbnMiLCJmaWVsZCIsImlwIiwic3BsaXQiLCJuZXQiLCJpc0lQIiwiRGVwcmVjYXRvciIsImxvZ1J1bnRpbWVEZXByZWNhdGlvbiIsInVzYWdlIiwiX21vdW50IiwibmV3VmFsdWUiLCJQYXJzZVNlcnZlck9wdGlvbnMiLCJ2YWxpZEtleXMiLCJSZXF1ZXN0Q29tcGxleGl0eU9wdGlvbnMiLCJkZWYiLCJkdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbkVuZm9yY2VBdXRoIiwiSW5zdGFsbGF0aW9uT3B0aW9ucyIsInZhbGlkQWN0aW9ucyIsImR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uIiwidmFsaWRQcmlvcml0aWVzIiwiZHVwbGljYXRlRGV2aWNlVG9rZW5NZXJnZVByaW9yaXR5IiwiaGVhZGVyIiwidHJpbSIsIkxvZ0xldmVscyIsInZhbGlkTG9nTGV2ZWxzIiwiaW5kZXhPZiIsIkpTT04iLCJzdHJpbmdpZnkiLCJlbmFibGVTY2hlbWFIb29rcyIsIkRhdGFiYXNlT3B0aW9ucyIsInNjaGVtYUNhY2hlVHRsIiwiYWxsb3dQdWJsaWNFeHBsYWluIiwicmVnZXhUaW1lb3V0IiwiTGl2ZVF1ZXJ5T3B0aW9ucyIsIm9wdGlvbnMiLCJvcHRpb24iLCJyZXF1ZXN0UGF0aCIsInBhdGhUb1JlZ2V4cCIsInJlcXVlc3RUaW1lV2luZG93IiwiaW5jbHVkZUludGVybmFsUmVxdWVzdHMiLCJyZXF1ZXN0Q291bnQiLCJlcnJvclJlc3BvbnNlTWVzc2FnZSIsIlBhcnNlU2VydmVyIiwiUmF0ZUxpbWl0Wm9uZSIsInpvbmUiLCJmb3JtYXR0ZXIiLCJJbnRsIiwiTGlzdEZvcm1hdCIsInN0eWxlIiwiZm9ybWF0Iiwibm93IiwiRGF0ZSIsImdldFRpbWUiLCJnZW5lcmF0ZVBhc3N3b3JkUmVzZXRUb2tlbkV4cGlyZXNBdCIsInVucmVnaXN0ZXJSYXRlTGltaXRlcnMiLCJpIiwicmF0ZUxpbWl0cyIsImxpbWl0IiwiY2xvdWQiLCJzcGxpY2UiLCJpbnZhbGlkTGlua1VSTCIsImludmFsaWRMaW5rIiwiaW52YWxpZFZlcmlmaWNhdGlvbkxpbmtVUkwiLCJpbnZhbGlkVmVyaWZpY2F0aW9uTGluayIsImxpbmtTZW5kU3VjY2Vzc1VSTCIsImxpbmtTZW5kU3VjY2VzcyIsImxpbmtTZW5kRmFpbFVSTCIsImxpbmtTZW5kRmFpbCIsInZlcmlmeUVtYWlsU3VjY2Vzc1VSTCIsInZlcmlmeUVtYWlsU3VjY2VzcyIsImNob29zZVBhc3N3b3JkVVJMIiwiY2hvb3NlUGFzc3dvcmQiLCJyZXF1ZXN0UmVzZXRQYXNzd29yZFVSTCIsInBhc3N3b3JkUmVzZXRTdWNjZXNzVVJMIiwicGFzc3dvcmRSZXNldFN1Y2Nlc3MiLCJwYXJzZUZyYW1lVVJMIiwidmVyaWZ5RW1haWxVUkwiLCJsb2FkTWFzdGVyS2V5IiwidHRsSXNFbXB0eSIsIm1hc3RlcktleVR0bCIsImlzRXhwaXJlZCIsIm1hc3RlcktleUNhY2hlIiwiZXhwaXJlc0F0Iiwic2VydmVyQ29uZmlnIiwiZXhwb3J0cyIsIl9kZWZhdWx0IiwibW9kdWxlIl0sInNvdXJjZXMiOlsiLi4vc3JjL0NvbmZpZy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBBIENvbmZpZyBvYmplY3QgcHJvdmlkZXMgaW5mb3JtYXRpb24gYWJvdXQgaG93IGEgc3BlY2lmaWMgYXBwIGlzXG4vLyBjb25maWd1cmVkLlxuLy8gbW91bnQgaXMgdGhlIFVSTCBmb3IgdGhlIHJvb3Qgb2YgdGhlIEFQSTsgaW5jbHVkZXMgaHR0cCwgZG9tYWluLCBldGMuXG5cbmltcG9ydCB7IGlzQm9vbGVhbiwgaXNTdHJpbmcgfSBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IHsgcGF0aFRvUmVnZXhwIH0gZnJvbSAncGF0aC10by1yZWdleHAnO1xuaW1wb3J0IG5ldCBmcm9tICduZXQnO1xuaW1wb3J0IEFwcENhY2hlIGZyb20gJy4vY2FjaGUnO1xuaW1wb3J0IERhdGFiYXNlQ29udHJvbGxlciBmcm9tICcuL0NvbnRyb2xsZXJzL0RhdGFiYXNlQ29udHJvbGxlcic7XG5pbXBvcnQgeyBsb2dMZXZlbHMgYXMgdmFsaWRMb2dMZXZlbHMgfSBmcm9tICcuL0NvbnRyb2xsZXJzL0xvZ2dlckNvbnRyb2xsZXInO1xuaW1wb3J0IHsgdmVyc2lvbiB9IGZyb20gJy4uL3BhY2thZ2UuanNvbic7XG5pbXBvcnQge1xuICBBY2NvdW50TG9ja291dE9wdGlvbnMsXG4gIERhdGFiYXNlT3B0aW9ucyxcbiAgRmlsZURvd25sb2FkT3B0aW9ucyxcbiAgRmlsZVVwbG9hZE9wdGlvbnMsXG4gIElkZW1wb3RlbmN5T3B0aW9ucyxcbiAgSW5zdGFsbGF0aW9uT3B0aW9ucyxcbiAgTGl2ZVF1ZXJ5T3B0aW9ucyxcbiAgTG9nTGV2ZWxzLFxuICBQYWdlc09wdGlvbnMsXG4gIFBhcnNlU2VydmVyT3B0aW9ucyxcbiAgU2NoZW1hT3B0aW9ucyxcbiAgUmVxdWVzdENvbXBsZXhpdHlPcHRpb25zLFxuICBTZWN1cml0eU9wdGlvbnMsXG59IGZyb20gJy4vT3B0aW9ucy9EZWZpbml0aW9ucyc7XG5pbXBvcnQgUGFyc2VTZXJ2ZXIgZnJvbSAnLi9jbG91ZC1jb2RlL1BhcnNlLlNlcnZlcic7XG5pbXBvcnQgRGVwcmVjYXRvciBmcm9tICcuL0RlcHJlY2F0b3IvRGVwcmVjYXRvcic7XG5pbXBvcnQgVXRpbHMgZnJvbSAnLi9VdGlscyc7XG5cbmZ1bmN0aW9uIHJlbW92ZVRyYWlsaW5nU2xhc2goc3RyKSB7XG4gIGlmICghc3RyKSB7XG4gICAgcmV0dXJuIHN0cjtcbiAgfVxuICBpZiAoc3RyLmVuZHNXaXRoKCcvJykpIHtcbiAgICBzdHIgPSBzdHIuc3Vic3RyaW5nKDAsIHN0ci5sZW5ndGggLSAxKTtcbiAgfVxuICByZXR1cm4gc3RyO1xufVxuXG4vKipcbiAqIENvbmZpZyBrZXlzIHRoYXQgbmVlZCB0byBiZSBsb2FkZWQgYXN5bmNocm9ub3VzbHkuXG4gKi9cbmNvbnN0IGFzeW5jS2V5cyA9IFsncHVibGljU2VydmVyVVJMJ107XG5cbmV4cG9ydCBjbGFzcyBDb25maWcge1xuICBzdGF0aWMgZ2V0KGFwcGxpY2F0aW9uSWQ6IHN0cmluZywgbW91bnQ6IHN0cmluZykge1xuICAgIGNvbnN0IGNhY2hlSW5mbyA9IEFwcENhY2hlLmdldChhcHBsaWNhdGlvbklkKTtcbiAgICBpZiAoIWNhY2hlSW5mbykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBjb25maWcgPSBuZXcgQ29uZmlnKCk7XG4gICAgY29uZmlnLmFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkO1xuICAgIE9iamVjdC5rZXlzKGNhY2hlSW5mbykuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgaWYgKGtleSAhPSAnZGF0YWJhc2VDb250cm9sbGVyJyAmJiBrZXkgIT0gJ2RhdGFiYXNlJykge1xuICAgICAgICBjb25maWdba2V5XSA9IGNhY2hlSW5mb1trZXldO1xuICAgICAgfVxuICAgIH0pO1xuICAgIC8vIEFsd2F5cyBjcmVhdGUgYSBuZXcgZGF0YWJhc2UgY29udHJvbGxlciwgYXMgaXQgaG9sZHMgcmVxdWVzdC1zY29wZWQgc3RhdGUgc3VjaCBhcyB0aGVcbiAgICAvLyB0cmFuc2FjdGlvbmFsIHNlc3Npb247IGEgcmVxdWVzdC1zY29wZWQgY29uZmlnIGluIHRoZSBjYWNoZSBoYXMgYGRhdGFiYXNlYCBpbnN0ZWFkIG9mXG4gICAgLy8gYGRhdGFiYXNlQ29udHJvbGxlcmBcbiAgICBjb25zdCBkYXRhYmFzZUNvbnRyb2xsZXIgPSBjYWNoZUluZm8uZGF0YWJhc2VDb250cm9sbGVyIHx8IGNhY2hlSW5mby5kYXRhYmFzZTtcbiAgICBpZiAoZGF0YWJhc2VDb250cm9sbGVyKSB7XG4gICAgICBjb25maWcuZGF0YWJhc2UgPSBuZXcgRGF0YWJhc2VDb250cm9sbGVyKGRhdGFiYXNlQ29udHJvbGxlci5hZGFwdGVyLCBjb25maWcpO1xuICAgIH1cbiAgICBjb25maWcubW91bnQgPSByZW1vdmVUcmFpbGluZ1NsYXNoKG1vdW50KTtcbiAgICBjb25maWcuZ2VuZXJhdGVTZXNzaW9uRXhwaXJlc0F0ID0gY29uZmlnLmdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdC5iaW5kKGNvbmZpZyk7XG4gICAgY29uZmlnLmdlbmVyYXRlRW1haWxWZXJpZnlUb2tlbkV4cGlyZXNBdCA9IGNvbmZpZy5nZW5lcmF0ZUVtYWlsVmVyaWZ5VG9rZW5FeHBpcmVzQXQuYmluZChcbiAgICAgIGNvbmZpZ1xuICAgICk7XG4gICAgY29uZmlnLnZlcnNpb24gPSB2ZXJzaW9uO1xuICAgIHJldHVybiBjb25maWc7XG4gIH1cblxuICBhc3luYyBsb2FkS2V5cygpIHtcbiAgICBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgIGFzeW5jS2V5cy5tYXAoYXN5bmMga2V5ID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB0aGlzW2BfJHtrZXl9YF0gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgdGhpc1trZXldID0gYXdhaXQgdGhpc1tgXyR7a2V5fWBdKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIHJlc29sdmUgYXN5bmMgY29uZmlnIGtleSAnJHtrZXl9JzogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSlcbiAgICApO1xuXG4gICAgY29uc3QgY2FjaGVkQ29uZmlnID0gQXBwQ2FjaGUuZ2V0KHRoaXMuYXBwSWQpO1xuICAgIGlmIChjYWNoZWRDb25maWcpIHtcbiAgICAgIGNvbnN0IHVwZGF0ZWRDb25maWcgPSB7IC4uLmNhY2hlZENvbmZpZyB9O1xuICAgICAgYXN5bmNLZXlzLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgdXBkYXRlZENvbmZpZ1trZXldID0gdGhpc1trZXldO1xuICAgICAgfSk7XG4gICAgICBBcHBDYWNoZS5wdXQodGhpcy5hcHBJZCwgdXBkYXRlZENvbmZpZyk7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHRyYW5zZm9ybUNvbmZpZ3VyYXRpb24oc2VydmVyQ29uZmlndXJhdGlvbikge1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHNlcnZlckNvbmZpZ3VyYXRpb24pKSB7XG4gICAgICBpZiAoYXN5bmNLZXlzLmluY2x1ZGVzKGtleSkgJiYgdHlwZW9mIHNlcnZlckNvbmZpZ3VyYXRpb25ba2V5XSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBzZXJ2ZXJDb25maWd1cmF0aW9uW2BfJHtrZXl9YF0gPSBzZXJ2ZXJDb25maWd1cmF0aW9uW2tleV07XG4gICAgICAgIGRlbGV0ZSBzZXJ2ZXJDb25maWd1cmF0aW9uW2tleV07XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHB1dChzZXJ2ZXJDb25maWd1cmF0aW9uKSB7XG4gICAgQ29uZmlnLnZhbGlkYXRlT3B0aW9ucyhzZXJ2ZXJDb25maWd1cmF0aW9uKTtcbiAgICBDb25maWcudmFsaWRhdGVDb250cm9sbGVycyhzZXJ2ZXJDb25maWd1cmF0aW9uKTtcbiAgICBpZiAoc2VydmVyQ29uZmlndXJhdGlvbi5yb3V0ZUFsbG93TGlzdCkge1xuICAgICAgc2VydmVyQ29uZmlndXJhdGlvbi5fcm91dGVBbGxvd0xpc3RSZWdleCA9IHNlcnZlckNvbmZpZ3VyYXRpb24ucm91dGVBbGxvd0xpc3QubWFwKFxuICAgICAgICBwYXR0ZXJuID0+IG5ldyBSZWdFeHAoJ14nICsgcGF0dGVybiArICckJylcbiAgICAgICk7XG4gICAgfVxuICAgIENvbmZpZy50cmFuc2Zvcm1Db25maWd1cmF0aW9uKHNlcnZlckNvbmZpZ3VyYXRpb24pO1xuICAgIEFwcENhY2hlLnB1dChzZXJ2ZXJDb25maWd1cmF0aW9uLmFwcElkLCBzZXJ2ZXJDb25maWd1cmF0aW9uKTtcbiAgICBDb25maWcuc2V0dXBQYXNzd29yZFZhbGlkYXRvcihzZXJ2ZXJDb25maWd1cmF0aW9uLnBhc3N3b3JkUG9saWN5KTtcbiAgICByZXR1cm4gc2VydmVyQ29uZmlndXJhdGlvbjtcbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZU9wdGlvbnMoe1xuICAgIGN1c3RvbVBhZ2VzLFxuICAgIHB1YmxpY1NlcnZlclVSTCxcbiAgICByZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0LFxuICAgIGV4cGlyZUluYWN0aXZlU2Vzc2lvbnMsXG4gICAgc2Vzc2lvbkxlbmd0aCxcbiAgICBkZWZhdWx0TGltaXQsXG4gICAgbWF4TGltaXQsXG4gICAgYWNjb3VudExvY2tvdXQsXG4gICAgcGFzc3dvcmRQb2xpY3ksXG4gICAgbWFzdGVyS2V5SXBzLFxuICAgIG1hc3RlcktleSxcbiAgICBtYWludGVuYW5jZUtleSxcbiAgICBtYWludGVuYW5jZUtleUlwcyxcbiAgICByZWFkT25seU1hc3RlcktleSxcbiAgICByZWFkT25seU1hc3RlcktleUlwcyxcbiAgICBhbGxvd0hlYWRlcnMsXG4gICAgaWRlbXBvdGVuY3lPcHRpb25zLFxuICAgIGZpbGVVcGxvYWQsXG4gICAgZmlsZURvd25sb2FkLFxuICAgIHBhZ2VzLFxuICAgIHNlY3VyaXR5LFxuICAgIGVuZm9yY2VQcml2YXRlVXNlcnMsXG4gICAgZW5hYmxlSW5zZWN1cmVBdXRoQWRhcHRlcnMsXG4gICAgc2NoZW1hLFxuICAgIHJlcXVlc3RLZXl3b3JkRGVueWxpc3QsXG4gICAgYWxsb3dFeHBpcmVkQXV0aERhdGFUb2tlbixcbiAgICBsb2dMZXZlbHMsXG4gICAgcmF0ZUxpbWl0LFxuICAgIGRhdGFiYXNlT3B0aW9ucyxcbiAgICBleHRlbmRTZXNzaW9uT25Vc2UsXG4gICAgYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uLFxuICAgIHJlcXVlc3RDb21wbGV4aXR5LFxuICAgIGxpdmVRdWVyeSxcbiAgICByb3V0ZUFsbG93TGlzdCxcbiAgICBpbnN0YWxsYXRpb24sXG4gIH0pIHtcbiAgICBpZiAobWFzdGVyS2V5ID09PSByZWFkT25seU1hc3RlcktleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtYXN0ZXJLZXkgYW5kIHJlYWRPbmx5TWFzdGVyS2V5IHNob3VsZCBiZSBkaWZmZXJlbnQnKTtcbiAgICB9XG5cbiAgICBpZiAobWFzdGVyS2V5ID09PSBtYWludGVuYW5jZUtleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtYXN0ZXJLZXkgYW5kIG1haW50ZW5hbmNlS2V5IHNob3VsZCBiZSBkaWZmZXJlbnQnKTtcbiAgICB9XG5cbiAgICB0aGlzLnZhbGlkYXRlQWNjb3VudExvY2tvdXRQb2xpY3koYWNjb3VudExvY2tvdXQpO1xuICAgIHRoaXMudmFsaWRhdGVQYXNzd29yZFBvbGljeShwYXNzd29yZFBvbGljeSk7XG4gICAgdGhpcy52YWxpZGF0ZUZpbGVVcGxvYWRPcHRpb25zKGZpbGVVcGxvYWQpO1xuICAgIGlmIChmaWxlRG93bmxvYWQgPT0gbnVsbCkge1xuICAgICAgZmlsZURvd25sb2FkID0ge307XG4gICAgICBhcmd1bWVudHNbMF0uZmlsZURvd25sb2FkID0gZmlsZURvd25sb2FkO1xuICAgIH1cbiAgICB0aGlzLnZhbGlkYXRlRmlsZURvd25sb2FkT3B0aW9ucyhmaWxlRG93bmxvYWQpO1xuXG4gICAgaWYgKHR5cGVvZiByZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0ICE9PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93ICdyZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0IG11c3QgYmUgYSBib29sZWFuIHZhbHVlJztcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGV4dGVuZFNlc3Npb25PblVzZSAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnZXh0ZW5kU2Vzc2lvbk9uVXNlIG11c3QgYmUgYSBib29sZWFuIHZhbHVlJztcbiAgICB9XG5cbiAgICB0aGlzLnZhbGlkYXRlUHVibGljU2VydmVyVVJMKHsgcHVibGljU2VydmVyVVJMIH0pO1xuICAgIHRoaXMudmFsaWRhdGVTZXNzaW9uQ29uZmlndXJhdGlvbihzZXNzaW9uTGVuZ3RoLCBleHBpcmVJbmFjdGl2ZVNlc3Npb25zKTtcbiAgICB0aGlzLnZhbGlkYXRlSXBzKCdtYXN0ZXJLZXlJcHMnLCBtYXN0ZXJLZXlJcHMpO1xuICAgIHRoaXMudmFsaWRhdGVJcHMoJ21haW50ZW5hbmNlS2V5SXBzJywgbWFpbnRlbmFuY2VLZXlJcHMpO1xuICAgIHRoaXMudmFsaWRhdGVJcHMoJ3JlYWRPbmx5TWFzdGVyS2V5SXBzJywgcmVhZE9ubHlNYXN0ZXJLZXlJcHMpO1xuICAgIHRoaXMudmFsaWRhdGVEZWZhdWx0TGltaXQoZGVmYXVsdExpbWl0KTtcbiAgICB0aGlzLnZhbGlkYXRlTWF4TGltaXQobWF4TGltaXQpO1xuICAgIHRoaXMudmFsaWRhdGVBbGxvd0hlYWRlcnMoYWxsb3dIZWFkZXJzKTtcbiAgICB0aGlzLnZhbGlkYXRlSWRlbXBvdGVuY3lPcHRpb25zKGlkZW1wb3RlbmN5T3B0aW9ucyk7XG4gICAgdGhpcy52YWxpZGF0ZVBhZ2VzT3B0aW9ucyhwYWdlcyk7XG4gICAgdGhpcy52YWxpZGF0ZVNlY3VyaXR5T3B0aW9ucyhzZWN1cml0eSk7XG4gICAgdGhpcy52YWxpZGF0ZVNjaGVtYU9wdGlvbnMoc2NoZW1hKTtcbiAgICB0aGlzLnZhbGlkYXRlRW5mb3JjZVByaXZhdGVVc2VycyhlbmZvcmNlUHJpdmF0ZVVzZXJzKTtcbiAgICB0aGlzLnZhbGlkYXRlRW5hYmxlSW5zZWN1cmVBdXRoQWRhcHRlcnMoZW5hYmxlSW5zZWN1cmVBdXRoQWRhcHRlcnMpO1xuICAgIHRoaXMudmFsaWRhdGVBbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuKGFsbG93RXhwaXJlZEF1dGhEYXRhVG9rZW4pO1xuICAgIHRoaXMudmFsaWRhdGVSZXF1ZXN0S2V5d29yZERlbnlsaXN0KHJlcXVlc3RLZXl3b3JkRGVueWxpc3QpO1xuICAgIHRoaXMudmFsaWRhdGVSYXRlTGltaXQocmF0ZUxpbWl0KTtcbiAgICB0aGlzLnZhbGlkYXRlTG9nTGV2ZWxzKGxvZ0xldmVscyk7XG4gICAgdGhpcy52YWxpZGF0ZURhdGFiYXNlT3B0aW9ucyhkYXRhYmFzZU9wdGlvbnMpO1xuICAgIHRoaXMudmFsaWRhdGVDdXN0b21QYWdlcyhjdXN0b21QYWdlcyk7XG4gICAgdGhpcy52YWxpZGF0ZUFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbihhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24pO1xuICAgIHRoaXMudmFsaWRhdGVSZXF1ZXN0Q29tcGxleGl0eShyZXF1ZXN0Q29tcGxleGl0eSk7XG4gICAgdGhpcy52YWxpZGF0ZUxpdmVRdWVyeU9wdGlvbnMobGl2ZVF1ZXJ5KTtcbiAgICB0aGlzLnZhbGlkYXRlUm91dGVBbGxvd0xpc3Qocm91dGVBbGxvd0xpc3QpO1xuICAgIHRoaXMudmFsaWRhdGVJbnN0YWxsYXRpb24oaW5zdGFsbGF0aW9uKTtcbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZUN1c3RvbVBhZ2VzKGN1c3RvbVBhZ2VzKSB7XG4gICAgaWYgKCFjdXN0b21QYWdlcykgeyByZXR1cm47IH1cblxuICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoY3VzdG9tUGFnZXMpICE9PSAnW29iamVjdCBPYmplY3RdJykge1xuICAgICAgdGhyb3cgRXJyb3IoJ1BhcnNlIFNlcnZlciBvcHRpb24gY3VzdG9tUGFnZXMgbXVzdCBiZSBhbiBvYmplY3QuJyk7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlQ29udHJvbGxlcnMoe1xuICAgIHZlcmlmeVVzZXJFbWFpbHMsXG4gICAgdXNlckNvbnRyb2xsZXIsXG4gICAgYXBwTmFtZSxcbiAgICBwdWJsaWNTZXJ2ZXJVUkwsXG4gICAgX3B1YmxpY1NlcnZlclVSTCxcbiAgICBlbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbixcbiAgICBlbWFpbFZlcmlmeVRva2VuUmV1c2VJZlZhbGlkLFxuICAgIGVtYWlsVmVyaWZ5U3VjY2Vzc09uSW52YWxpZEVtYWlsLFxuICB9KSB7XG4gICAgY29uc3QgZW1haWxBZGFwdGVyID0gdXNlckNvbnRyb2xsZXIuYWRhcHRlcjtcbiAgICBpZiAodmVyaWZ5VXNlckVtYWlscykge1xuICAgICAgdGhpcy52YWxpZGF0ZUVtYWlsQ29uZmlndXJhdGlvbih7XG4gICAgICAgIGVtYWlsQWRhcHRlcixcbiAgICAgICAgYXBwTmFtZSxcbiAgICAgICAgcHVibGljU2VydmVyVVJMOiBwdWJsaWNTZXJ2ZXJVUkwgfHwgX3B1YmxpY1NlcnZlclVSTCxcbiAgICAgICAgZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24sXG4gICAgICAgIGVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQsXG4gICAgICAgIGVtYWlsVmVyaWZ5U3VjY2Vzc09uSW52YWxpZEVtYWlsLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlUmVxdWVzdEtleXdvcmREZW55bGlzdChyZXF1ZXN0S2V5d29yZERlbnlsaXN0KSB7XG4gICAgaWYgKHJlcXVlc3RLZXl3b3JkRGVueWxpc3QgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVxdWVzdEtleXdvcmREZW55bGlzdCA9IHJlcXVlc3RLZXl3b3JkRGVueWxpc3QuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFBcnJheS5pc0FycmF5KHJlcXVlc3RLZXl3b3JkRGVueWxpc3QpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiByZXF1ZXN0S2V5d29yZERlbnlsaXN0IG11c3QgYmUgYW4gYXJyYXkuJztcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVFbmZvcmNlUHJpdmF0ZVVzZXJzKGVuZm9yY2VQcml2YXRlVXNlcnMpIHtcbiAgICBpZiAodHlwZW9mIGVuZm9yY2VQcml2YXRlVXNlcnMgIT09ICdib29sZWFuJykge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gZW5mb3JjZVByaXZhdGVVc2VycyBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZUFsbG93RXhwaXJlZEF1dGhEYXRhVG9rZW4oYWxsb3dFeHBpcmVkQXV0aERhdGFUb2tlbikge1xuICAgIGlmICh0eXBlb2YgYWxsb3dFeHBpcmVkQXV0aERhdGFUb2tlbiAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBhbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuIG11c3QgYmUgYSBib29sZWFuLic7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlQWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uKGFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbikge1xuICAgIGlmICh0eXBlb2YgYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uICE9PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIGFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZVNlY3VyaXR5T3B0aW9ucyhzZWN1cml0eSkge1xuICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoc2VjdXJpdHkpICE9PSAnW29iamVjdCBPYmplY3RdJykge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gc2VjdXJpdHkgbXVzdCBiZSBhbiBvYmplY3QuJztcbiAgICB9XG4gICAgaWYgKHNlY3VyaXR5LmVuYWJsZUNoZWNrID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHNlY3VyaXR5LmVuYWJsZUNoZWNrID0gU2VjdXJpdHlPcHRpb25zLmVuYWJsZUNoZWNrLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghaXNCb29sZWFuKHNlY3VyaXR5LmVuYWJsZUNoZWNrKSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gc2VjdXJpdHkuZW5hYmxlQ2hlY2sgbXVzdCBiZSBhIGJvb2xlYW4uJztcbiAgICB9XG4gICAgaWYgKHNlY3VyaXR5LmVuYWJsZUNoZWNrTG9nID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHNlY3VyaXR5LmVuYWJsZUNoZWNrTG9nID0gU2VjdXJpdHlPcHRpb25zLmVuYWJsZUNoZWNrTG9nLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghaXNCb29sZWFuKHNlY3VyaXR5LmVuYWJsZUNoZWNrTG9nKSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gc2VjdXJpdHkuZW5hYmxlQ2hlY2tMb2cgbXVzdCBiZSBhIGJvb2xlYW4uJztcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVTY2hlbWFPcHRpb25zKHNjaGVtYTogU2NoZW1hT3B0aW9ucykge1xuICAgIGlmICghc2NoZW1hKSB7IHJldHVybjsgfVxuICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoc2NoZW1hKSAhPT0gJ1tvYmplY3QgT2JqZWN0XScpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHNjaGVtYSBtdXN0IGJlIGFuIG9iamVjdC4nO1xuICAgIH1cbiAgICBpZiAoc2NoZW1hLmRlZmluaXRpb25zID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHNjaGVtYS5kZWZpbml0aW9ucyA9IFNjaGVtYU9wdGlvbnMuZGVmaW5pdGlvbnMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFBcnJheS5pc0FycmF5KHNjaGVtYS5kZWZpbml0aW9ucykpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHNjaGVtYS5kZWZpbml0aW9ucyBtdXN0IGJlIGFuIGFycmF5Lic7XG4gICAgfVxuICAgIGlmIChzY2hlbWEuc3RyaWN0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHNjaGVtYS5zdHJpY3QgPSBTY2hlbWFPcHRpb25zLnN0cmljdC5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzQm9vbGVhbihzY2hlbWEuc3RyaWN0KSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gc2NoZW1hLnN0cmljdCBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgICBpZiAoc2NoZW1hLmRlbGV0ZUV4dHJhRmllbGRzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHNjaGVtYS5kZWxldGVFeHRyYUZpZWxkcyA9IFNjaGVtYU9wdGlvbnMuZGVsZXRlRXh0cmFGaWVsZHMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFpc0Jvb2xlYW4oc2NoZW1hLmRlbGV0ZUV4dHJhRmllbGRzKSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gc2NoZW1hLmRlbGV0ZUV4dHJhRmllbGRzIG11c3QgYmUgYSBib29sZWFuLic7XG4gICAgfVxuICAgIGlmIChzY2hlbWEucmVjcmVhdGVNb2RpZmllZEZpZWxkcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBzY2hlbWEucmVjcmVhdGVNb2RpZmllZEZpZWxkcyA9IFNjaGVtYU9wdGlvbnMucmVjcmVhdGVNb2RpZmllZEZpZWxkcy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzQm9vbGVhbihzY2hlbWEucmVjcmVhdGVNb2RpZmllZEZpZWxkcykpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHNjaGVtYS5yZWNyZWF0ZU1vZGlmaWVkRmllbGRzIG11c3QgYmUgYSBib29sZWFuLic7XG4gICAgfVxuICAgIGlmIChzY2hlbWEubG9ja1NjaGVtYXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgc2NoZW1hLmxvY2tTY2hlbWFzID0gU2NoZW1hT3B0aW9ucy5sb2NrU2NoZW1hcy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzQm9vbGVhbihzY2hlbWEubG9ja1NjaGVtYXMpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBzY2hlbWEubG9ja1NjaGVtYXMgbXVzdCBiZSBhIGJvb2xlYW4uJztcbiAgICB9XG4gICAgaWYgKHNjaGVtYS5iZWZvcmVNaWdyYXRpb24gPT09IHVuZGVmaW5lZCkge1xuICAgICAgc2NoZW1hLmJlZm9yZU1pZ3JhdGlvbiA9IG51bGw7XG4gICAgfSBlbHNlIGlmIChzY2hlbWEuYmVmb3JlTWlncmF0aW9uICE9PSBudWxsICYmIHR5cGVvZiBzY2hlbWEuYmVmb3JlTWlncmF0aW9uICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBzY2hlbWEuYmVmb3JlTWlncmF0aW9uIG11c3QgYmUgYSBmdW5jdGlvbi4nO1xuICAgIH1cbiAgICBpZiAoc2NoZW1hLmFmdGVyTWlncmF0aW9uID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHNjaGVtYS5hZnRlck1pZ3JhdGlvbiA9IG51bGw7XG4gICAgfSBlbHNlIGlmIChzY2hlbWEuYWZ0ZXJNaWdyYXRpb24gIT09IG51bGwgJiYgdHlwZW9mIHNjaGVtYS5hZnRlck1pZ3JhdGlvbiAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gc2NoZW1hLmFmdGVyTWlncmF0aW9uIG11c3QgYmUgYSBmdW5jdGlvbi4nO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZVBhZ2VzT3B0aW9ucyhwYWdlcykge1xuICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwocGFnZXMpICE9PSAnW29iamVjdCBPYmplY3RdJykge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gcGFnZXMgbXVzdCBiZSBhbiBvYmplY3QuJztcbiAgICB9XG4gICAgaWYgKHBhZ2VzLmVuYWJsZUxvY2FsaXphdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBwYWdlcy5lbmFibGVMb2NhbGl6YXRpb24gPSBQYWdlc09wdGlvbnMuZW5hYmxlTG9jYWxpemF0aW9uLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghaXNCb29sZWFuKHBhZ2VzLmVuYWJsZUxvY2FsaXphdGlvbikpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHBhZ2VzLmVuYWJsZUxvY2FsaXphdGlvbiBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgICBpZiAocGFnZXMubG9jYWxpemF0aW9uSnNvblBhdGggPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGFnZXMubG9jYWxpemF0aW9uSnNvblBhdGggPSBQYWdlc09wdGlvbnMubG9jYWxpemF0aW9uSnNvblBhdGguZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFpc1N0cmluZyhwYWdlcy5sb2NhbGl6YXRpb25Kc29uUGF0aCkpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHBhZ2VzLmxvY2FsaXphdGlvbkpzb25QYXRoIG11c3QgYmUgYSBzdHJpbmcuJztcbiAgICB9XG4gICAgaWYgKHBhZ2VzLmxvY2FsaXphdGlvbkZhbGxiYWNrTG9jYWxlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHBhZ2VzLmxvY2FsaXphdGlvbkZhbGxiYWNrTG9jYWxlID0gUGFnZXNPcHRpb25zLmxvY2FsaXphdGlvbkZhbGxiYWNrTG9jYWxlLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghaXNTdHJpbmcocGFnZXMubG9jYWxpemF0aW9uRmFsbGJhY2tMb2NhbGUpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBwYWdlcy5sb2NhbGl6YXRpb25GYWxsYmFja0xvY2FsZSBtdXN0IGJlIGEgc3RyaW5nLic7XG4gICAgfVxuICAgIGlmIChwYWdlcy5wbGFjZWhvbGRlcnMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGFnZXMucGxhY2Vob2xkZXJzID0gUGFnZXNPcHRpb25zLnBsYWNlaG9sZGVycy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoXG4gICAgICBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwocGFnZXMucGxhY2Vob2xkZXJzKSAhPT0gJ1tvYmplY3QgT2JqZWN0XScgJiZcbiAgICAgIHR5cGVvZiBwYWdlcy5wbGFjZWhvbGRlcnMgIT09ICdmdW5jdGlvbidcbiAgICApIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHBhZ2VzLnBsYWNlaG9sZGVycyBtdXN0IGJlIGFuIG9iamVjdCBvciBhIGZ1bmN0aW9uLic7XG4gICAgfVxuICAgIGlmIChwYWdlcy5mb3JjZVJlZGlyZWN0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHBhZ2VzLmZvcmNlUmVkaXJlY3QgPSBQYWdlc09wdGlvbnMuZm9yY2VSZWRpcmVjdC5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzQm9vbGVhbihwYWdlcy5mb3JjZVJlZGlyZWN0KSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gcGFnZXMuZm9yY2VSZWRpcmVjdCBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgICBpZiAocGFnZXMucGFnZXNQYXRoICE9PSB1bmRlZmluZWQgJiYgIWlzU3RyaW5nKHBhZ2VzLnBhZ2VzUGF0aCkpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHBhZ2VzLnBhZ2VzUGF0aCBtdXN0IGJlIGEgc3RyaW5nLic7XG4gICAgfVxuICAgIGlmIChwYWdlcy5wYWdlc0VuZHBvaW50ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHBhZ2VzLnBhZ2VzRW5kcG9pbnQgPSBQYWdlc09wdGlvbnMucGFnZXNFbmRwb2ludC5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzU3RyaW5nKHBhZ2VzLnBhZ2VzRW5kcG9pbnQpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBwYWdlcy5wYWdlc0VuZHBvaW50IG11c3QgYmUgYSBzdHJpbmcuJztcbiAgICB9XG4gICAgaWYgKHBhZ2VzLmN1c3RvbVVybHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGFnZXMuY3VzdG9tVXJscyA9IFBhZ2VzT3B0aW9ucy5jdXN0b21VcmxzLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwocGFnZXMuY3VzdG9tVXJscykgIT09ICdbb2JqZWN0IE9iamVjdF0nKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBwYWdlcy5jdXN0b21VcmxzIG11c3QgYmUgYW4gb2JqZWN0Lic7XG4gICAgfVxuICAgIGlmIChwYWdlcy5jdXN0b21Sb3V0ZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGFnZXMuY3VzdG9tUm91dGVzID0gUGFnZXNPcHRpb25zLmN1c3RvbVJvdXRlcy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIUFycmF5LmlzQXJyYXkocGFnZXMuY3VzdG9tUm91dGVzKSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gcGFnZXMuY3VzdG9tUm91dGVzIG11c3QgYmUgYW4gYXJyYXkuJztcbiAgICB9XG4gICAgaWYgKHBhZ2VzLmVuY29kZVBhZ2VQYXJhbUhlYWRlcnMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGFnZXMuZW5jb2RlUGFnZVBhcmFtSGVhZGVycyA9IFBhZ2VzT3B0aW9ucy5lbmNvZGVQYWdlUGFyYW1IZWFkZXJzLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghaXNCb29sZWFuKHBhZ2VzLmVuY29kZVBhZ2VQYXJhbUhlYWRlcnMpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBwYWdlcy5lbmNvZGVQYWdlUGFyYW1IZWFkZXJzIG11c3QgYmUgYSBib29sZWFuLic7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlSWRlbXBvdGVuY3lPcHRpb25zKGlkZW1wb3RlbmN5T3B0aW9ucykge1xuICAgIGlmICghaWRlbXBvdGVuY3lPcHRpb25zKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChpZGVtcG90ZW5jeU9wdGlvbnMudHRsID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGlkZW1wb3RlbmN5T3B0aW9ucy50dGwgPSBJZGVtcG90ZW5jeU9wdGlvbnMudHRsLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghaXNOYU4oaWRlbXBvdGVuY3lPcHRpb25zLnR0bCkgJiYgaWRlbXBvdGVuY3lPcHRpb25zLnR0bCA8PSAwKSB7XG4gICAgICB0aHJvdyAnaWRlbXBvdGVuY3kgVFRMIHZhbHVlIG11c3QgYmUgZ3JlYXRlciB0aGFuIDAgc2Vjb25kcyc7XG4gICAgfSBlbHNlIGlmIChpc05hTihpZGVtcG90ZW5jeU9wdGlvbnMudHRsKSkge1xuICAgICAgdGhyb3cgJ2lkZW1wb3RlbmN5IFRUTCB2YWx1ZSBtdXN0IGJlIGEgbnVtYmVyJztcbiAgICB9XG4gICAgaWYgKCFpZGVtcG90ZW5jeU9wdGlvbnMucGF0aHMpIHtcbiAgICAgIGlkZW1wb3RlbmN5T3B0aW9ucy5wYXRocyA9IElkZW1wb3RlbmN5T3B0aW9ucy5wYXRocy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIUFycmF5LmlzQXJyYXkoaWRlbXBvdGVuY3lPcHRpb25zLnBhdGhzKSkge1xuICAgICAgdGhyb3cgJ2lkZW1wb3RlbmN5IHBhdGhzIG11c3QgYmUgb2YgYW4gYXJyYXkgb2Ygc3RyaW5ncyc7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlQWNjb3VudExvY2tvdXRQb2xpY3koYWNjb3VudExvY2tvdXQpIHtcbiAgICBpZiAoYWNjb3VudExvY2tvdXQpIHtcbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIGFjY291bnRMb2Nrb3V0LmR1cmF0aW9uICE9PSAnbnVtYmVyJyB8fFxuICAgICAgICBhY2NvdW50TG9ja291dC5kdXJhdGlvbiA8PSAwIHx8XG4gICAgICAgIGFjY291bnRMb2Nrb3V0LmR1cmF0aW9uID4gOTk5OTlcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAnQWNjb3VudCBsb2Nrb3V0IGR1cmF0aW9uIHNob3VsZCBiZSBncmVhdGVyIHRoYW4gMCBhbmQgbGVzcyB0aGFuIDEwMDAwMCc7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgIU51bWJlci5pc0ludGVnZXIoYWNjb3VudExvY2tvdXQudGhyZXNob2xkKSB8fFxuICAgICAgICBhY2NvdW50TG9ja291dC50aHJlc2hvbGQgPCAxIHx8XG4gICAgICAgIGFjY291bnRMb2Nrb3V0LnRocmVzaG9sZCA+IDk5OVxuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdBY2NvdW50IGxvY2tvdXQgdGhyZXNob2xkIHNob3VsZCBiZSBhbiBpbnRlZ2VyIGdyZWF0ZXIgdGhhbiAwIGFuZCBsZXNzIHRoYW4gMTAwMCc7XG4gICAgICB9XG5cbiAgICAgIGlmIChhY2NvdW50TG9ja291dC51bmxvY2tPblBhc3N3b3JkUmVzZXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICBhY2NvdW50TG9ja291dC51bmxvY2tPblBhc3N3b3JkUmVzZXQgPSBBY2NvdW50TG9ja291dE9wdGlvbnMudW5sb2NrT25QYXNzd29yZFJlc2V0LmRlZmF1bHQ7XG4gICAgICB9IGVsc2UgaWYgKCFpc0Jvb2xlYW4oYWNjb3VudExvY2tvdXQudW5sb2NrT25QYXNzd29yZFJlc2V0KSkge1xuICAgICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBhY2NvdW50TG9ja291dC51bmxvY2tPblBhc3N3b3JkUmVzZXQgbXVzdCBiZSBhIGJvb2xlYW4uJztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVQYXNzd29yZFBvbGljeShwYXNzd29yZFBvbGljeSkge1xuICAgIGlmIChwYXNzd29yZFBvbGljeSkge1xuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZSAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICh0eXBlb2YgcGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UgIT09ICdudW1iZXInIHx8IHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlIDwgMClcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UgbXVzdCBiZSBhIHBvc2l0aXZlIG51bWJlcic7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgcGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb24gIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAodHlwZW9mIHBhc3N3b3JkUG9saWN5LnJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uICE9PSAnbnVtYmVyJyB8fFxuICAgICAgICAgIHBhc3N3b3JkUG9saWN5LnJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uIDw9IDApXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgJ3Bhc3N3b3JkUG9saWN5LnJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uIG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXInO1xuICAgICAgfVxuXG4gICAgICBpZiAocGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yUGF0dGVybikge1xuICAgICAgICBpZiAodHlwZW9mIHBhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4gPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yUGF0dGVybiA9IG5ldyBSZWdFeHAocGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yUGF0dGVybik7XG4gICAgICAgIH0gZWxzZSBpZiAoIVV0aWxzLmlzUmVnRXhwKHBhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4pKSB7XG4gICAgICAgICAgdGhyb3cgJ3Bhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4gbXVzdCBiZSBhIHJlZ2V4IHN0cmluZyBvciBSZWdFeHAgb2JqZWN0Lic7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayAmJlxuICAgICAgICB0eXBlb2YgcGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sgIT09ICdmdW5jdGlvbidcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sgbXVzdCBiZSBhIGZ1bmN0aW9uLic7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgcGFzc3dvcmRQb2xpY3kuZG9Ob3RBbGxvd1VzZXJuYW1lICYmXG4gICAgICAgIHR5cGVvZiBwYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgIT09ICdib29sZWFuJ1xuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdwYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgbXVzdCBiZSBhIGJvb2xlYW4gdmFsdWUuJztcbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgJiZcbiAgICAgICAgKCFOdW1iZXIuaXNJbnRlZ2VyKHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSkgfHxcbiAgICAgICAgICBwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgPD0gMCB8fFxuICAgICAgICAgIHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSA+IDIwKVxuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgbXVzdCBiZSBhbiBpbnRlZ2VyIHJhbmdpbmcgMCAtIDIwJztcbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS5yZXNldFRva2VuUmV1c2VJZlZhbGlkICYmXG4gICAgICAgIHR5cGVvZiBwYXNzd29yZFBvbGljeS5yZXNldFRva2VuUmV1c2VJZlZhbGlkICE9PSAnYm9vbGVhbidcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncmVzZXRUb2tlblJldXNlSWZWYWxpZCBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZSc7XG4gICAgICB9XG4gICAgICBpZiAocGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblJldXNlSWZWYWxpZCAmJiAhcGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb24pIHtcbiAgICAgICAgdGhyb3cgJ1lvdSBjYW5ub3QgdXNlIHJlc2V0VG9rZW5SZXVzZUlmVmFsaWQgd2l0aG91dCByZXNldFRva2VuVmFsaWRpdHlEdXJhdGlvbic7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgcGFzc3dvcmRQb2xpY3kucmVzZXRQYXNzd29yZFN1Y2Nlc3NPbkludmFsaWRFbWFpbCAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgIHR5cGVvZiBwYXNzd29yZFBvbGljeS5yZXNldFBhc3N3b3JkU3VjY2Vzc09uSW52YWxpZEVtYWlsICE9PSAnYm9vbGVhbidcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncmVzZXRQYXNzd29yZFN1Y2Nlc3NPbkludmFsaWRFbWFpbCBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZSc7XG4gICAgICB9XG5cbiAgICB9XG4gIH1cblxuICAvLyBpZiB0aGUgcGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yUGF0dGVybiBpcyBjb25maWd1cmVkIHRoZW4gc2V0dXAgYSBjYWxsYmFjayB0byBwcm9jZXNzIHRoZSBwYXR0ZXJuXG4gIHN0YXRpYyBzZXR1cFBhc3N3b3JkVmFsaWRhdG9yKHBhc3N3b3JkUG9saWN5KSB7XG4gICAgaWYgKHBhc3N3b3JkUG9saWN5ICYmIHBhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4pIHtcbiAgICAgIHBhc3N3b3JkUG9saWN5LnBhdHRlcm5WYWxpZGF0b3IgPSB2YWx1ZSA9PiB7XG4gICAgICAgIHJldHVybiBwYXNzd29yZFBvbGljeS52YWxpZGF0b3JQYXR0ZXJuLnRlc3QodmFsdWUpO1xuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVQdWJsaWNTZXJ2ZXJVUkwoeyBwdWJsaWNTZXJ2ZXJVUkwsIHJlcXVpcmVkID0gZmFsc2UgfSkge1xuICAgIGlmICghcHVibGljU2VydmVyVVJMKSB7XG4gICAgICBpZiAoIXJlcXVpcmVkKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRocm93ICdUaGUgb3B0aW9uIHB1YmxpY1NlcnZlclVSTCBpcyByZXF1aXJlZC4nO1xuICAgIH1cblxuICAgIGNvbnN0IHR5cGUgPSB0eXBlb2YgcHVibGljU2VydmVyVVJMO1xuXG4gICAgaWYgKHR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgICBpZiAoIXB1YmxpY1NlcnZlclVSTC5zdGFydHNXaXRoKCdodHRwOi8vJykgJiYgIXB1YmxpY1NlcnZlclVSTC5zdGFydHNXaXRoKCdodHRwczovLycpKSB7XG4gICAgICAgIHRocm93ICdUaGUgb3B0aW9uIHB1YmxpY1NlcnZlclVSTCBtdXN0IGJlIGEgdmFsaWQgVVJMIHN0YXJ0aW5nIHdpdGggaHR0cDovLyBvciBodHRwczovLy4nO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICh0eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhyb3cgYFRoZSBvcHRpb24gcHVibGljU2VydmVyVVJMIG11c3QgYmUgYSBzdHJpbmcgb3IgZnVuY3Rpb24sIGJ1dCBnb3QgJHt0eXBlfS5gO1xuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlRW1haWxDb25maWd1cmF0aW9uKHtcbiAgICBlbWFpbEFkYXB0ZXIsXG4gICAgYXBwTmFtZSxcbiAgICBwdWJsaWNTZXJ2ZXJVUkwsXG4gICAgZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24sXG4gICAgZW1haWxWZXJpZnlUb2tlblJldXNlSWZWYWxpZCxcbiAgICBlbWFpbFZlcmlmeVN1Y2Nlc3NPbkludmFsaWRFbWFpbCxcbiAgfSkge1xuICAgIGlmICghZW1haWxBZGFwdGVyKSB7XG4gICAgICB0aHJvdyAnQW4gZW1haWxBZGFwdGVyIGlzIHJlcXVpcmVkIGZvciBlLW1haWwgdmVyaWZpY2F0aW9uIGFuZCBwYXNzd29yZCByZXNldHMuJztcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBhcHBOYW1lICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgJ0FuIGFwcCBuYW1lIGlzIHJlcXVpcmVkIGZvciBlLW1haWwgdmVyaWZpY2F0aW9uIGFuZCBwYXNzd29yZCByZXNldHMuJztcbiAgICB9XG4gICAgdGhpcy52YWxpZGF0ZVB1YmxpY1NlcnZlclVSTCh7IHB1YmxpY1NlcnZlclVSTCwgcmVxdWlyZWQ6IHRydWUgfSk7XG4gICAgaWYgKGVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uKSB7XG4gICAgICBpZiAoaXNOYU4oZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24pKSB7XG4gICAgICAgIHRocm93ICdFbWFpbCB2ZXJpZnkgdG9rZW4gdmFsaWRpdHkgZHVyYXRpb24gbXVzdCBiZSBhIHZhbGlkIG51bWJlci4nO1xuICAgICAgfSBlbHNlIGlmIChlbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbiA8PSAwKSB7XG4gICAgICAgIHRocm93ICdFbWFpbCB2ZXJpZnkgdG9rZW4gdmFsaWRpdHkgZHVyYXRpb24gbXVzdCBiZSBhIHZhbHVlIGdyZWF0ZXIgdGhhbiAwLic7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChlbWFpbFZlcmlmeVRva2VuUmV1c2VJZlZhbGlkICYmIHR5cGVvZiBlbWFpbFZlcmlmeVRva2VuUmV1c2VJZlZhbGlkICE9PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93ICdlbWFpbFZlcmlmeVRva2VuUmV1c2VJZlZhbGlkIG11c3QgYmUgYSBib29sZWFuIHZhbHVlJztcbiAgICB9XG4gICAgaWYgKGVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQgJiYgIWVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uKSB7XG4gICAgICB0aHJvdyAnWW91IGNhbm5vdCB1c2UgZW1haWxWZXJpZnlUb2tlblJldXNlSWZWYWxpZCB3aXRob3V0IGVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uJztcbiAgICB9XG4gICAgaWYgKGVtYWlsVmVyaWZ5U3VjY2Vzc09uSW52YWxpZEVtYWlsICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIGVtYWlsVmVyaWZ5U3VjY2Vzc09uSW52YWxpZEVtYWlsICE9PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93ICdlbWFpbFZlcmlmeVN1Y2Nlc3NPbkludmFsaWRFbWFpbCBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZSc7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlRmlsZVVwbG9hZE9wdGlvbnMoZmlsZVVwbG9hZCkge1xuICAgIHRyeSB7XG4gICAgICBpZiAoZmlsZVVwbG9hZCA9PSBudWxsIHx8IHR5cGVvZiBmaWxlVXBsb2FkICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGZpbGVVcGxvYWQpKSB7XG4gICAgICAgIHRocm93ICdmaWxlVXBsb2FkIG11c3QgYmUgYW4gb2JqZWN0IHZhbHVlLic7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBSZWZlcmVuY2VFcnJvcikge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgICBpZiAoZmlsZVVwbG9hZC5lbmFibGVGb3JBbm9ueW1vdXNVc2VyID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpbGVVcGxvYWQuZW5hYmxlRm9yQW5vbnltb3VzVXNlciA9IEZpbGVVcGxvYWRPcHRpb25zLmVuYWJsZUZvckFub255bW91c1VzZXIuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWxlVXBsb2FkLmVuYWJsZUZvckFub255bW91c1VzZXIgIT09ICdib29sZWFuJykge1xuICAgICAgdGhyb3cgJ2ZpbGVVcGxvYWQuZW5hYmxlRm9yQW5vbnltb3VzVXNlciBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZS4nO1xuICAgIH1cbiAgICBpZiAoZmlsZVVwbG9hZC5lbmFibGVGb3JQdWJsaWMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmlsZVVwbG9hZC5lbmFibGVGb3JQdWJsaWMgPSBGaWxlVXBsb2FkT3B0aW9ucy5lbmFibGVGb3JQdWJsaWMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWxlVXBsb2FkLmVuYWJsZUZvclB1YmxpYyAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnZmlsZVVwbG9hZC5lbmFibGVGb3JQdWJsaWMgbXVzdCBiZSBhIGJvb2xlYW4gdmFsdWUuJztcbiAgICB9XG4gICAgaWYgKGZpbGVVcGxvYWQuZW5hYmxlRm9yQXV0aGVudGljYXRlZFVzZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmlsZVVwbG9hZC5lbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciA9IEZpbGVVcGxvYWRPcHRpb25zLmVuYWJsZUZvckF1dGhlbnRpY2F0ZWRVc2VyLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZmlsZVVwbG9hZC5lbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnZmlsZVVwbG9hZC5lbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZS4nO1xuICAgIH1cbiAgICBpZiAoZmlsZVVwbG9hZC5maWxlRXh0ZW5zaW9ucyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBmaWxlVXBsb2FkLmZpbGVFeHRlbnNpb25zID0gRmlsZVVwbG9hZE9wdGlvbnMuZmlsZUV4dGVuc2lvbnMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFBcnJheS5pc0FycmF5KGZpbGVVcGxvYWQuZmlsZUV4dGVuc2lvbnMpKSB7XG4gICAgICB0aHJvdyAnZmlsZVVwbG9hZC5maWxlRXh0ZW5zaW9ucyBtdXN0IGJlIGFuIGFycmF5Lic7XG4gICAgfVxuICAgIGlmIChmaWxlVXBsb2FkLmFsbG93ZWRGaWxlVXJsRG9tYWlucyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBmaWxlVXBsb2FkLmFsbG93ZWRGaWxlVXJsRG9tYWlucyA9IEZpbGVVcGxvYWRPcHRpb25zLmFsbG93ZWRGaWxlVXJsRG9tYWlucy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIUFycmF5LmlzQXJyYXkoZmlsZVVwbG9hZC5hbGxvd2VkRmlsZVVybERvbWFpbnMpKSB7XG4gICAgICB0aHJvdyAnZmlsZVVwbG9hZC5hbGxvd2VkRmlsZVVybERvbWFpbnMgbXVzdCBiZSBhbiBhcnJheS4nO1xuICAgIH0gZWxzZSB7XG4gICAgICBmb3IgKGNvbnN0IGRvbWFpbiBvZiBmaWxlVXBsb2FkLmFsbG93ZWRGaWxlVXJsRG9tYWlucykge1xuICAgICAgICBpZiAodHlwZW9mIGRvbWFpbiAhPT0gJ3N0cmluZycgfHwgZG9tYWluID09PSAnJykge1xuICAgICAgICAgIHRocm93ICdmaWxlVXBsb2FkLmFsbG93ZWRGaWxlVXJsRG9tYWlucyBtdXN0IGNvbnRhaW4gb25seSBub24tZW1wdHkgc3RyaW5ncy4nO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlRmlsZURvd25sb2FkT3B0aW9ucyhmaWxlRG93bmxvYWQpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKGZpbGVEb3dubG9hZCA9PSBudWxsIHx8IHR5cGVvZiBmaWxlRG93bmxvYWQgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkoZmlsZURvd25sb2FkKSkge1xuICAgICAgICB0aHJvdyAnZmlsZURvd25sb2FkIG11c3QgYmUgYW4gb2JqZWN0IHZhbHVlLic7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBSZWZlcmVuY2VFcnJvcikge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgICBpZiAoZmlsZURvd25sb2FkLmVuYWJsZUZvckFub255bW91c1VzZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmlsZURvd25sb2FkLmVuYWJsZUZvckFub255bW91c1VzZXIgPSBGaWxlRG93bmxvYWRPcHRpb25zLmVuYWJsZUZvckFub255bW91c1VzZXIuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWxlRG93bmxvYWQuZW5hYmxlRm9yQW5vbnltb3VzVXNlciAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnZmlsZURvd25sb2FkLmVuYWJsZUZvckFub255bW91c1VzZXIgbXVzdCBiZSBhIGJvb2xlYW4gdmFsdWUuJztcbiAgICB9XG4gICAgaWYgKGZpbGVEb3dubG9hZC5lbmFibGVGb3JQdWJsaWMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmlsZURvd25sb2FkLmVuYWJsZUZvclB1YmxpYyA9IEZpbGVEb3dubG9hZE9wdGlvbnMuZW5hYmxlRm9yUHVibGljLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZmlsZURvd25sb2FkLmVuYWJsZUZvclB1YmxpYyAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnZmlsZURvd25sb2FkLmVuYWJsZUZvclB1YmxpYyBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZS4nO1xuICAgIH1cbiAgICBpZiAoZmlsZURvd25sb2FkLmVuYWJsZUZvckF1dGhlbnRpY2F0ZWRVc2VyID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpbGVEb3dubG9hZC5lbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciA9IEZpbGVEb3dubG9hZE9wdGlvbnMuZW5hYmxlRm9yQXV0aGVudGljYXRlZFVzZXIuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWxlRG93bmxvYWQuZW5hYmxlRm9yQXV0aGVudGljYXRlZFVzZXIgIT09ICdib29sZWFuJykge1xuICAgICAgdGhyb3cgJ2ZpbGVEb3dubG9hZC5lbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZS4nO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZUlwcyhmaWVsZCwgbWFzdGVyS2V5SXBzKSB7XG4gICAgZm9yIChsZXQgaXAgb2YgbWFzdGVyS2V5SXBzKSB7XG4gICAgICBpZiAoaXAuaW5jbHVkZXMoJy8nKSkge1xuICAgICAgICBpcCA9IGlwLnNwbGl0KCcvJylbMF07XG4gICAgICB9XG4gICAgICBpZiAoIW5ldC5pc0lQKGlwKSkge1xuICAgICAgICB0aHJvdyBgVGhlIFBhcnNlIFNlcnZlciBvcHRpb24gXCIke2ZpZWxkfVwiIGNvbnRhaW5zIGFuIGludmFsaWQgSVAgYWRkcmVzcyBcIiR7aXB9XCIuYDtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVFbmFibGVJbnNlY3VyZUF1dGhBZGFwdGVycyhlbmFibGVJbnNlY3VyZUF1dGhBZGFwdGVycykge1xuICAgIGlmIChlbmFibGVJbnNlY3VyZUF1dGhBZGFwdGVycyAmJiB0eXBlb2YgZW5hYmxlSW5zZWN1cmVBdXRoQWRhcHRlcnMgIT09ICdib29sZWFuJykge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gZW5hYmxlSW5zZWN1cmVBdXRoQWRhcHRlcnMgbXVzdCBiZSBhIGJvb2xlYW4uJztcbiAgICB9XG4gICAgaWYgKGVuYWJsZUluc2VjdXJlQXV0aEFkYXB0ZXJzKSB7XG4gICAgICBEZXByZWNhdG9yLmxvZ1J1bnRpbWVEZXByZWNhdGlvbih7IHVzYWdlOiAnaW5zZWN1cmUgYWRhcHRlcicgfSk7XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vdW50KCkge1xuICAgIHZhciBtb3VudCA9IHRoaXMuX21vdW50O1xuICAgIGlmICh0aGlzLnB1YmxpY1NlcnZlclVSTCkge1xuICAgICAgbW91bnQgPSB0aGlzLnB1YmxpY1NlcnZlclVSTDtcbiAgICB9XG4gICAgcmV0dXJuIG1vdW50O1xuICB9XG5cbiAgc2V0IG1vdW50KG5ld1ZhbHVlKSB7XG4gICAgdGhpcy5fbW91bnQgPSBuZXdWYWx1ZTtcbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZVNlc3Npb25Db25maWd1cmF0aW9uKHNlc3Npb25MZW5ndGgsIGV4cGlyZUluYWN0aXZlU2Vzc2lvbnMpIHtcbiAgICBpZiAoZXhwaXJlSW5hY3RpdmVTZXNzaW9ucykge1xuICAgICAgaWYgKGlzTmFOKHNlc3Npb25MZW5ndGgpKSB7XG4gICAgICAgIHRocm93ICdTZXNzaW9uIGxlbmd0aCBtdXN0IGJlIGEgdmFsaWQgbnVtYmVyLic7XG4gICAgICB9IGVsc2UgaWYgKHNlc3Npb25MZW5ndGggPD0gMCkge1xuICAgICAgICB0aHJvdyAnU2Vzc2lvbiBsZW5ndGggbXVzdCBiZSBhIHZhbHVlIGdyZWF0ZXIgdGhhbiAwLic7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlRGVmYXVsdExpbWl0KGRlZmF1bHRMaW1pdCkge1xuICAgIGlmIChkZWZhdWx0TGltaXQgPT0gbnVsbCkge1xuICAgICAgZGVmYXVsdExpbWl0ID0gUGFyc2VTZXJ2ZXJPcHRpb25zLmRlZmF1bHRMaW1pdC5kZWZhdWx0O1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGRlZmF1bHRMaW1pdCAhPT0gJ251bWJlcicpIHtcbiAgICAgIHRocm93ICdEZWZhdWx0IGxpbWl0IG11c3QgYmUgYSBudW1iZXIuJztcbiAgICB9XG4gICAgaWYgKGRlZmF1bHRMaW1pdCA8PSAwKSB7XG4gICAgICB0aHJvdyAnRGVmYXVsdCBsaW1pdCBtdXN0IGJlIGEgdmFsdWUgZ3JlYXRlciB0aGFuIDAuJztcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVNYXhMaW1pdChtYXhMaW1pdCkge1xuICAgIGlmIChtYXhMaW1pdCA8PSAwKSB7XG4gICAgICB0aHJvdyAnTWF4IGxpbWl0IG11c3QgYmUgYSB2YWx1ZSBncmVhdGVyIHRoYW4gMC4nO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZVJlcXVlc3RDb21wbGV4aXR5KHJlcXVlc3RDb21wbGV4aXR5KSB7XG4gICAgaWYgKHJlcXVlc3RDb21wbGV4aXR5ID09IG51bGwpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiByZXF1ZXN0Q29tcGxleGl0eSAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShyZXF1ZXN0Q29tcGxleGl0eSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcigncmVxdWVzdENvbXBsZXhpdHkgbXVzdCBiZSBhbiBvYmplY3QuJyk7XG4gICAgfVxuICAgIGNvbnN0IHZhbGlkS2V5cyA9IE9iamVjdC5rZXlzKFJlcXVlc3RDb21wbGV4aXR5T3B0aW9ucyk7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocmVxdWVzdENvbXBsZXhpdHkpKSB7XG4gICAgICBpZiAoIXZhbGlkS2V5cy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgcmVxdWVzdENvbXBsZXhpdHkgY29udGFpbnMgdW5rbm93biBwcm9wZXJ0eSAnJHtrZXl9Jy5gKTtcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yIChjb25zdCBrZXkgb2YgdmFsaWRLZXlzKSB7XG4gICAgICBpZiAocmVxdWVzdENvbXBsZXhpdHlba2V5XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVxdWVzdENvbXBsZXhpdHlba2V5XTtcbiAgICAgICAgY29uc3QgZGVmID0gUmVxdWVzdENvbXBsZXhpdHlPcHRpb25zW2tleV07XG4gICAgICAgIGlmICh0eXBlb2YgZGVmLmRlZmF1bHQgPT09ICdib29sZWFuJykge1xuICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGByZXF1ZXN0Q29tcGxleGl0eS4ke2tleX0gbXVzdCBiZSBhIGJvb2xlYW4uYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCAodmFsdWUgPCAxICYmIHZhbHVlICE9PSAtMSkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHJlcXVlc3RDb21wbGV4aXR5LiR7a2V5fSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlciBvciAtMSB0byBkaXNhYmxlLmApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXF1ZXN0Q29tcGxleGl0eVtrZXldID0gUmVxdWVzdENvbXBsZXhpdHlPcHRpb25zW2tleV0uZGVmYXVsdDtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVJbnN0YWxsYXRpb24oaW5zdGFsbGF0aW9uKSB7XG4gICAgaWYgKGluc3RhbGxhdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBlb2YgaW5zdGFsbGF0aW9uICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGluc3RhbGxhdGlvbikgfHwgaW5zdGFsbGF0aW9uID09PSBudWxsKSB7XG4gICAgICB0aHJvdyAnaW5zdGFsbGF0aW9uIG11c3QgYmUgYW4gb2JqZWN0Lic7XG4gICAgfVxuICAgIGNvbnN0IHZhbGlkS2V5cyA9IFtcbiAgICAgICdkdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbkVuZm9yY2VBdXRoJyxcbiAgICAgICdkdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbicsXG4gICAgICAnZHVwbGljYXRlRGV2aWNlVG9rZW5NZXJnZVByaW9yaXR5JyxcbiAgICBdO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGluc3RhbGxhdGlvbikpIHtcbiAgICAgIGlmICghdmFsaWRLZXlzLmluY2x1ZGVzKGtleSkpIHtcbiAgICAgICAgdGhyb3cgYGluc3RhbGxhdGlvbiBjb250YWlucyB1bmtub3duIHByb3BlcnR5ICcke2tleX0nLmA7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChpbnN0YWxsYXRpb24uZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb25FbmZvcmNlQXV0aCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBpbnN0YWxsYXRpb24uZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb25FbmZvcmNlQXV0aCA9XG4gICAgICAgIEluc3RhbGxhdGlvbk9wdGlvbnMuZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb25FbmZvcmNlQXV0aC5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGluc3RhbGxhdGlvbi5kdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbkVuZm9yY2VBdXRoICE9PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93ICdpbnN0YWxsYXRpb24uZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb25FbmZvcmNlQXV0aCBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgICBjb25zdCB2YWxpZEFjdGlvbnMgPSBbJ2RlbGV0ZScsICd1cGRhdGUnXTtcbiAgICBpZiAoaW5zdGFsbGF0aW9uLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGluc3RhbGxhdGlvbi5kdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbiA9XG4gICAgICAgIEluc3RhbGxhdGlvbk9wdGlvbnMuZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24uZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCF2YWxpZEFjdGlvbnMuaW5jbHVkZXMoaW5zdGFsbGF0aW9uLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uKSkge1xuICAgICAgdGhyb3cgXCJpbnN0YWxsYXRpb24uZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24gbXVzdCBiZSBvbmUgb2Y6ICdkZWxldGUnLCAndXBkYXRlJy5cIjtcbiAgICB9XG4gICAgY29uc3QgdmFsaWRQcmlvcml0aWVzID0gWydkZXZpY2VUb2tlbicsICdpbnN0YWxsYXRpb25JZCddO1xuICAgIGlmIChpbnN0YWxsYXRpb24uZHVwbGljYXRlRGV2aWNlVG9rZW5NZXJnZVByaW9yaXR5ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGluc3RhbGxhdGlvbi5kdXBsaWNhdGVEZXZpY2VUb2tlbk1lcmdlUHJpb3JpdHkgPVxuICAgICAgICBJbnN0YWxsYXRpb25PcHRpb25zLmR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2VQcmlvcml0eS5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIXZhbGlkUHJpb3JpdGllcy5pbmNsdWRlcyhpbnN0YWxsYXRpb24uZHVwbGljYXRlRGV2aWNlVG9rZW5NZXJnZVByaW9yaXR5KSkge1xuICAgICAgdGhyb3cgXCJpbnN0YWxsYXRpb24uZHVwbGljYXRlRGV2aWNlVG9rZW5NZXJnZVByaW9yaXR5IG11c3QgYmUgb25lIG9mOiAnZGV2aWNlVG9rZW4nLCAnaW5zdGFsbGF0aW9uSWQnLlwiO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZUFsbG93SGVhZGVycyhhbGxvd0hlYWRlcnMpIHtcbiAgICBpZiAoIVtudWxsLCB1bmRlZmluZWRdLmluY2x1ZGVzKGFsbG93SGVhZGVycykpIHtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KGFsbG93SGVhZGVycykpIHtcbiAgICAgICAgYWxsb3dIZWFkZXJzLmZvckVhY2goaGVhZGVyID0+IHtcbiAgICAgICAgICBpZiAodHlwZW9mIGhlYWRlciAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93ICdBbGxvdyBoZWFkZXJzIG11c3Qgb25seSBjb250YWluIHN0cmluZ3MnO1xuICAgICAgICAgIH0gZWxzZSBpZiAoIWhlYWRlci50cmltKCkubGVuZ3RoKSB7XG4gICAgICAgICAgICB0aHJvdyAnQWxsb3cgaGVhZGVycyBtdXN0IG5vdCBjb250YWluIGVtcHR5IHN0cmluZ3MnO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyAnQWxsb3cgaGVhZGVycyBtdXN0IGJlIGFuIGFycmF5JztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVMb2dMZXZlbHMobG9nTGV2ZWxzKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoTG9nTGV2ZWxzKSkge1xuICAgICAgaWYgKGxvZ0xldmVsc1trZXldKSB7XG4gICAgICAgIGlmICh2YWxpZExvZ0xldmVscy5pbmRleE9mKGxvZ0xldmVsc1trZXldKSA9PT0gLTEpIHtcbiAgICAgICAgICB0aHJvdyBgJyR7a2V5fScgbXVzdCBiZSBvbmUgb2YgJHtKU09OLnN0cmluZ2lmeSh2YWxpZExvZ0xldmVscyl9YDtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9nTGV2ZWxzW2tleV0gPSBMb2dMZXZlbHNba2V5XS5kZWZhdWx0O1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZURhdGFiYXNlT3B0aW9ucyhkYXRhYmFzZU9wdGlvbnMpIHtcbiAgICBpZiAoZGF0YWJhc2VPcHRpb25zID09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKGRhdGFiYXNlT3B0aW9ucykgIT09ICdbb2JqZWN0IE9iamVjdF0nKSB7XG4gICAgICB0aHJvdyBgZGF0YWJhc2VPcHRpb25zIG11c3QgYmUgYW4gb2JqZWN0YDtcbiAgICB9XG5cbiAgICBpZiAoZGF0YWJhc2VPcHRpb25zLmVuYWJsZVNjaGVtYUhvb2tzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRhdGFiYXNlT3B0aW9ucy5lbmFibGVTY2hlbWFIb29rcyA9IERhdGFiYXNlT3B0aW9ucy5lbmFibGVTY2hlbWFIb29rcy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGRhdGFiYXNlT3B0aW9ucy5lbmFibGVTY2hlbWFIb29rcyAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyBgZGF0YWJhc2VPcHRpb25zLmVuYWJsZVNjaGVtYUhvb2tzIG11c3QgYmUgYSBib29sZWFuYDtcbiAgICB9XG4gICAgaWYgKGRhdGFiYXNlT3B0aW9ucy5zY2hlbWFDYWNoZVR0bCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkYXRhYmFzZU9wdGlvbnMuc2NoZW1hQ2FjaGVUdGwgPSBEYXRhYmFzZU9wdGlvbnMuc2NoZW1hQ2FjaGVUdGwuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBkYXRhYmFzZU9wdGlvbnMuc2NoZW1hQ2FjaGVUdGwgIT09ICdudW1iZXInKSB7XG4gICAgICB0aHJvdyBgZGF0YWJhc2VPcHRpb25zLnNjaGVtYUNhY2hlVHRsIG11c3QgYmUgYSBudW1iZXJgO1xuICAgIH1cbiAgICBpZiAoZGF0YWJhc2VPcHRpb25zLmFsbG93UHVibGljRXhwbGFpbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkYXRhYmFzZU9wdGlvbnMuYWxsb3dQdWJsaWNFeHBsYWluID0gRGF0YWJhc2VPcHRpb25zLmFsbG93UHVibGljRXhwbGFpbi5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGRhdGFiYXNlT3B0aW9ucy5hbGxvd1B1YmxpY0V4cGxhaW4gIT09ICdib29sZWFuJykge1xuICAgICAgdGhyb3cgYFBhcnNlIFNlcnZlciBvcHRpb24gJ2RhdGFiYXNlT3B0aW9ucy5hbGxvd1B1YmxpY0V4cGxhaW4nIG11c3QgYmUgYSBib29sZWFuLmA7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlTGl2ZVF1ZXJ5T3B0aW9ucyhsaXZlUXVlcnkpIHtcbiAgICBpZiAobGl2ZVF1ZXJ5ID09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobGl2ZVF1ZXJ5LnJlZ2V4VGltZW91dCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBsaXZlUXVlcnkucmVnZXhUaW1lb3V0ID0gTGl2ZVF1ZXJ5T3B0aW9ucy5yZWdleFRpbWVvdXQuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBsaXZlUXVlcnkucmVnZXhUaW1lb3V0ICE9PSAnbnVtYmVyJykge1xuICAgICAgdGhyb3cgYGxpdmVRdWVyeS5yZWdleFRpbWVvdXQgbXVzdCBiZSBhIG51bWJlcmA7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlUm91dGVBbGxvd0xpc3Qocm91dGVBbGxvd0xpc3QpIHtcbiAgICBpZiAocm91dGVBbGxvd0xpc3QgPT09IHVuZGVmaW5lZCB8fCByb3V0ZUFsbG93TGlzdCA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocm91dGVBbGxvd0xpc3QpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiByb3V0ZUFsbG93TGlzdCBtdXN0IGJlIGFuIGFycmF5IG9mIHN0cmluZ3MuJztcbiAgICB9XG4gICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHJvdXRlQWxsb3dMaXN0KSB7XG4gICAgICBpZiAodHlwZW9mIHBhdHRlcm4gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRocm93IGBQYXJzZSBTZXJ2ZXIgb3B0aW9uIHJvdXRlQWxsb3dMaXN0IGNvbnRhaW5zIGEgbm9uLXN0cmluZyB2YWx1ZS5gO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgbmV3IFJlZ0V4cCgnXicgKyBwYXR0ZXJuICsgJyQnKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICB0aHJvdyBgUGFyc2UgU2VydmVyIG9wdGlvbiByb3V0ZUFsbG93TGlzdCBjb250YWlucyBhbiBpbnZhbGlkIHJlZ2V4IHBhdHRlcm46IFwiJHtwYXR0ZXJufVwiLmA7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlUmF0ZUxpbWl0KHJhdGVMaW1pdCkge1xuICAgIGlmICghcmF0ZUxpbWl0KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChcbiAgICAgIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChyYXRlTGltaXQpICE9PSAnW29iamVjdCBPYmplY3RdJyAmJlxuICAgICAgIUFycmF5LmlzQXJyYXkocmF0ZUxpbWl0KVxuICAgICkge1xuICAgICAgdGhyb3cgYHJhdGVMaW1pdCBtdXN0IGJlIGFuIGFycmF5IG9yIG9iamVjdGA7XG4gICAgfVxuICAgIGNvbnN0IG9wdGlvbnMgPSBBcnJheS5pc0FycmF5KHJhdGVMaW1pdCkgPyByYXRlTGltaXQgOiBbcmF0ZUxpbWl0XTtcbiAgICBmb3IgKGNvbnN0IG9wdGlvbiBvZiBvcHRpb25zKSB7XG4gICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG9wdGlvbikgIT09ICdbb2JqZWN0IE9iamVjdF0nKSB7XG4gICAgICAgIHRocm93IGByYXRlTGltaXQgbXVzdCBiZSBhbiBhcnJheSBvZiBvYmplY3RzYDtcbiAgICAgIH1cbiAgICAgIGlmIChvcHRpb24ucmVxdWVzdFBhdGggPT0gbnVsbCkge1xuICAgICAgICB0aHJvdyBgcmF0ZUxpbWl0LnJlcXVlc3RQYXRoIG11c3QgYmUgZGVmaW5lZGA7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIG9wdGlvbi5yZXF1ZXN0UGF0aCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgdGhyb3cgYHJhdGVMaW1pdC5yZXF1ZXN0UGF0aCBtdXN0IGJlIGEgc3RyaW5nYDtcbiAgICAgIH1cblxuICAgICAgLy8gVmFsaWRhdGUgdGhhdCB0aGUgcGF0aCBpcyB2YWxpZCBwYXRoLXRvLXJlZ2V4cCBzeW50YXhcbiAgICAgIHRyeSB7XG4gICAgICAgIHBhdGhUb1JlZ2V4cChvcHRpb24ucmVxdWVzdFBhdGgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhyb3cgYHJhdGVMaW1pdC5yZXF1ZXN0UGF0aCBcIiR7b3B0aW9uLnJlcXVlc3RQYXRofVwiIGlzIG5vdCB2YWxpZDogJHtlcnJvci5tZXNzYWdlfWA7XG4gICAgICB9XG5cbiAgICAgIGlmIChvcHRpb24ucmVxdWVzdFRpbWVXaW5kb3cgPT0gbnVsbCkge1xuICAgICAgICB0aHJvdyBgcmF0ZUxpbWl0LnJlcXVlc3RUaW1lV2luZG93IG11c3QgYmUgZGVmaW5lZGA7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIG9wdGlvbi5yZXF1ZXN0VGltZVdpbmRvdyAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgdGhyb3cgYHJhdGVMaW1pdC5yZXF1ZXN0VGltZVdpbmRvdyBtdXN0IGJlIGEgbnVtYmVyYDtcbiAgICAgIH1cbiAgICAgIGlmIChvcHRpb24uaW5jbHVkZUludGVybmFsUmVxdWVzdHMgJiYgdHlwZW9mIG9wdGlvbi5pbmNsdWRlSW50ZXJuYWxSZXF1ZXN0cyAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIHRocm93IGByYXRlTGltaXQuaW5jbHVkZUludGVybmFsUmVxdWVzdHMgbXVzdCBiZSBhIGJvb2xlYW5gO1xuICAgICAgfVxuICAgICAgaWYgKG9wdGlvbi5yZXF1ZXN0Q291bnQgPT0gbnVsbCkge1xuICAgICAgICB0aHJvdyBgcmF0ZUxpbWl0LnJlcXVlc3RDb3VudCBtdXN0IGJlIGRlZmluZWRgO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBvcHRpb24ucmVxdWVzdENvdW50ICE9PSAnbnVtYmVyJykge1xuICAgICAgICB0aHJvdyBgcmF0ZUxpbWl0LnJlcXVlc3RDb3VudCBtdXN0IGJlIGEgbnVtYmVyYDtcbiAgICAgIH1cbiAgICAgIGlmIChvcHRpb24uZXJyb3JSZXNwb25zZU1lc3NhZ2UgJiYgdHlwZW9mIG9wdGlvbi5lcnJvclJlc3BvbnNlTWVzc2FnZSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgdGhyb3cgYHJhdGVMaW1pdC5lcnJvclJlc3BvbnNlTWVzc2FnZSBtdXN0IGJlIGEgc3RyaW5nYDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG9wdGlvbnMgPSBPYmplY3Qua2V5cyhQYXJzZVNlcnZlci5SYXRlTGltaXRab25lKTtcbiAgICAgIGlmIChvcHRpb24uem9uZSAmJiAhb3B0aW9ucy5pbmNsdWRlcyhvcHRpb24uem9uZSkpIHtcbiAgICAgICAgY29uc3QgZm9ybWF0dGVyID0gbmV3IEludGwuTGlzdEZvcm1hdCgnZW4nLCB7IHN0eWxlOiAnc2hvcnQnLCB0eXBlOiAnZGlzanVuY3Rpb24nIH0pO1xuICAgICAgICB0aHJvdyBgcmF0ZUxpbWl0LnpvbmUgbXVzdCBiZSBvbmUgb2YgJHtmb3JtYXR0ZXIuZm9ybWF0KG9wdGlvbnMpfWA7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZ2VuZXJhdGVFbWFpbFZlcmlmeVRva2VuRXhwaXJlc0F0KCkge1xuICAgIGlmICghdGhpcy52ZXJpZnlVc2VyRW1haWxzIHx8ICF0aGlzLmVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICB2YXIgbm93ID0gbmV3IERhdGUoKTtcbiAgICByZXR1cm4gbmV3IERhdGUobm93LmdldFRpbWUoKSArIHRoaXMuZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24gKiAxMDAwKTtcbiAgfVxuXG4gIGdlbmVyYXRlUGFzc3dvcmRSZXNldFRva2VuRXhwaXJlc0F0KCkge1xuICAgIGlmICghdGhpcy5wYXNzd29yZFBvbGljeSB8fCAhdGhpcy5wYXNzd29yZFBvbGljeS5yZXNldFRva2VuVmFsaWRpdHlEdXJhdGlvbikge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKTtcbiAgICByZXR1cm4gbmV3IERhdGUobm93LmdldFRpbWUoKSArIHRoaXMucGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb24gKiAxMDAwKTtcbiAgfVxuXG4gIGdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCgpIHtcbiAgICBpZiAoIXRoaXMuZXhwaXJlSW5hY3RpdmVTZXNzaW9ucykge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG4gICAgdmFyIG5vdyA9IG5ldyBEYXRlKCk7XG4gICAgcmV0dXJuIG5ldyBEYXRlKG5vdy5nZXRUaW1lKCkgKyB0aGlzLnNlc3Npb25MZW5ndGggKiAxMDAwKTtcbiAgfVxuXG4gIHVucmVnaXN0ZXJSYXRlTGltaXRlcnMoKSB7XG4gICAgbGV0IGkgPSB0aGlzLnJhdGVMaW1pdHM/Lmxlbmd0aDtcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICBjb25zdCBsaW1pdCA9IHRoaXMucmF0ZUxpbWl0c1tpXTtcbiAgICAgIGlmIChsaW1pdC5jbG91ZCkge1xuICAgICAgICB0aGlzLnJhdGVMaW1pdHMuc3BsaWNlKGksIDEpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGdldCBpbnZhbGlkTGlua1VSTCgpIHtcbiAgICByZXR1cm4gdGhpcy5jdXN0b21QYWdlcy5pbnZhbGlkTGluayB8fCBgJHt0aGlzLnB1YmxpY1NlcnZlclVSTH0vYXBwcy9pbnZhbGlkX2xpbmsuaHRtbGA7XG4gIH1cblxuICBnZXQgaW52YWxpZFZlcmlmaWNhdGlvbkxpbmtVUkwoKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIHRoaXMuY3VzdG9tUGFnZXMuaW52YWxpZFZlcmlmaWNhdGlvbkxpbmsgfHxcbiAgICAgIGAke3RoaXMucHVibGljU2VydmVyVVJMfS9hcHBzL2ludmFsaWRfdmVyaWZpY2F0aW9uX2xpbmsuaHRtbGBcbiAgICApO1xuICB9XG5cbiAgZ2V0IGxpbmtTZW5kU3VjY2Vzc1VSTCgpIHtcbiAgICByZXR1cm4gKFxuICAgICAgdGhpcy5jdXN0b21QYWdlcy5saW5rU2VuZFN1Y2Nlc3MgfHwgYCR7dGhpcy5wdWJsaWNTZXJ2ZXJVUkx9L2FwcHMvbGlua19zZW5kX3N1Y2Nlc3MuaHRtbGBcbiAgICApO1xuICB9XG5cbiAgZ2V0IGxpbmtTZW5kRmFpbFVSTCgpIHtcbiAgICByZXR1cm4gdGhpcy5jdXN0b21QYWdlcy5saW5rU2VuZEZhaWwgfHwgYCR7dGhpcy5wdWJsaWNTZXJ2ZXJVUkx9L2FwcHMvbGlua19zZW5kX2ZhaWwuaHRtbGA7XG4gIH1cblxuICBnZXQgdmVyaWZ5RW1haWxTdWNjZXNzVVJMKCkge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLmN1c3RvbVBhZ2VzLnZlcmlmeUVtYWlsU3VjY2VzcyB8fFxuICAgICAgYCR7dGhpcy5wdWJsaWNTZXJ2ZXJVUkx9L2FwcHMvdmVyaWZ5X2VtYWlsX3N1Y2Nlc3MuaHRtbGBcbiAgICApO1xuICB9XG5cbiAgZ2V0IGNob29zZVBhc3N3b3JkVVJMKCkge1xuICAgIHJldHVybiB0aGlzLmN1c3RvbVBhZ2VzLmNob29zZVBhc3N3b3JkIHx8IGAke3RoaXMucHVibGljU2VydmVyVVJMfS9hcHBzL2Nob29zZV9wYXNzd29yZGA7XG4gIH1cblxuICBnZXQgcmVxdWVzdFJlc2V0UGFzc3dvcmRVUkwoKSB7XG4gICAgcmV0dXJuIGAke3RoaXMucHVibGljU2VydmVyVVJMfS8ke3RoaXMucGFnZXNFbmRwb2ludH0vJHt0aGlzLmFwcGxpY2F0aW9uSWR9L3JlcXVlc3RfcGFzc3dvcmRfcmVzZXRgO1xuICB9XG5cbiAgZ2V0IHBhc3N3b3JkUmVzZXRTdWNjZXNzVVJMKCkge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLmN1c3RvbVBhZ2VzLnBhc3N3b3JkUmVzZXRTdWNjZXNzIHx8XG4gICAgICBgJHt0aGlzLnB1YmxpY1NlcnZlclVSTH0vYXBwcy9wYXNzd29yZF9yZXNldF9zdWNjZXNzLmh0bWxgXG4gICAgKTtcbiAgfVxuXG4gIGdldCBwYXJzZUZyYW1lVVJMKCkge1xuICAgIHJldHVybiB0aGlzLmN1c3RvbVBhZ2VzLnBhcnNlRnJhbWVVUkw7XG4gIH1cblxuICBnZXQgdmVyaWZ5RW1haWxVUkwoKSB7XG4gICAgcmV0dXJuIGAke3RoaXMucHVibGljU2VydmVyVVJMfS8ke3RoaXMucGFnZXNFbmRwb2ludH0vJHt0aGlzLmFwcGxpY2F0aW9uSWR9L3ZlcmlmeV9lbWFpbGA7XG4gIH1cblxuICBhc3luYyBsb2FkTWFzdGVyS2V5KCkge1xuICAgIGlmICh0eXBlb2YgdGhpcy5tYXN0ZXJLZXkgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGNvbnN0IHR0bElzRW1wdHkgPSAhdGhpcy5tYXN0ZXJLZXlUdGw7XG4gICAgICBjb25zdCBpc0V4cGlyZWQgPSB0aGlzLm1hc3RlcktleUNhY2hlPy5leHBpcmVzQXQgJiYgdGhpcy5tYXN0ZXJLZXlDYWNoZS5leHBpcmVzQXQgPCBuZXcgRGF0ZSgpO1xuXG4gICAgICBpZiAoKCFpc0V4cGlyZWQgfHwgdHRsSXNFbXB0eSkgJiYgdGhpcy5tYXN0ZXJLZXlDYWNoZT8ubWFzdGVyS2V5KSB7XG4gICAgICAgIHJldHVybiB0aGlzLm1hc3RlcktleUNhY2hlLm1hc3RlcktleTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWFzdGVyS2V5ID0gYXdhaXQgdGhpcy5tYXN0ZXJLZXkoKTtcblxuICAgICAgY29uc3QgZXhwaXJlc0F0ID0gdGhpcy5tYXN0ZXJLZXlUdGwgPyBuZXcgRGF0ZShEYXRlLm5vdygpICsgMTAwMCAqIHRoaXMubWFzdGVyS2V5VHRsKSA6IG51bGxcbiAgICAgIHRoaXMubWFzdGVyS2V5Q2FjaGUgPSB7IG1hc3RlcktleSwgZXhwaXJlc0F0IH07XG4gICAgICAvLyBVcGRhdGUgb25seSB0aGUgY2FjaGVkIHNlcnZlciBjb25maWcsIGFzIHRoaXMgY29uZmlnIGlzIHJlcXVlc3Qtc2NvcGVkXG4gICAgICBjb25zdCBzZXJ2ZXJDb25maWcgPSBBcHBDYWNoZS5nZXQodGhpcy5hcHBsaWNhdGlvbklkKTtcbiAgICAgIGlmIChzZXJ2ZXJDb25maWcpIHtcbiAgICAgICAgc2VydmVyQ29uZmlnLm1hc3RlcktleUNhY2hlID0gdGhpcy5tYXN0ZXJLZXlDYWNoZTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXMubWFzdGVyS2V5Q2FjaGUubWFzdGVyS2V5O1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLm1hc3RlcktleTtcbiAgfVxuXG4gIGdldCBwYWdlc0VuZHBvaW50KCkge1xuICAgIHJldHVybiB0aGlzLnBhZ2VzICYmIHRoaXMucGFnZXMucGFnZXNFbmRwb2ludFxuICAgICAgPyB0aGlzLnBhZ2VzLnBhZ2VzRW5kcG9pbnRcbiAgICAgIDogJ2FwcHMnO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IENvbmZpZztcbm1vZHVsZS5leHBvcnRzID0gQ29uZmlnO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFJQSxJQUFBQSxPQUFBLEdBQUFDLE9BQUE7QUFDQSxJQUFBQyxhQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxJQUFBLEdBQUFDLHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBSSxNQUFBLEdBQUFELHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBSyxtQkFBQSxHQUFBRixzQkFBQSxDQUFBSCxPQUFBO0FBQ0EsSUFBQU0saUJBQUEsR0FBQU4sT0FBQTtBQUNBLElBQUFPLFFBQUEsR0FBQVAsT0FBQTtBQUNBLElBQUFRLFlBQUEsR0FBQVIsT0FBQTtBQWVBLElBQUFTLE1BQUEsR0FBQU4sc0JBQUEsQ0FBQUgsT0FBQTtBQUNBLElBQUFVLFdBQUEsR0FBQVAsc0JBQUEsQ0FBQUgsT0FBQTtBQUNBLElBQUFXLE1BQUEsR0FBQVIsc0JBQUEsQ0FBQUgsT0FBQTtBQUE0QixTQUFBRyx1QkFBQVMsQ0FBQSxXQUFBQSxDQUFBLElBQUFBLENBQUEsQ0FBQUMsVUFBQSxHQUFBRCxDQUFBLEtBQUFFLE9BQUEs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RUFFQSxNQUFNMFAsYUFBYUEsQ0FBQSxFQUFHO0lBQ3BCLElBQUksT0FBTyxJQUFJLENBQUMxTSxTQUFTLEtBQUssVUFBVSxFQUFFO01BQ3hDLE1BQU0yTSxVQUFVLEdBQUcsQ0FBQyxJQUFJLENBQUNDLFlBQVk7TUFDckMsTUFBTUMsU0FBUyxHQUFHLElBQUksQ0FBQ0MsY0FBYyxFQUFFQyxTQUFTLElBQUksSUFBSSxDQUFDRCxjQUFjLENBQUNDLFNBQVMsR0FBRyxJQUFJL0IsSUFBSSxDQUFDLENBQUM7TUFFOUYsSUFBSSxDQUFDLENBQUM2QixTQUFTLElBQUlGLFVBQVUsS0FBSyxJQUFJLENBQUNHLGNBQWMsRUFBRTlNLFNBQVMsRUFBRTtRQUNoRSxPQUFPLElBQUksQ0FBQzhNLGNBQWMsQ0FBQzlNLFNBQVM7TUFDdEM7TUFFQSxNQUFNQSxTQUFTLEdBQUcsTUFBTSxJQUFJLENBQUNBLFNBQVMsQ0FBQyxDQUFDO01BRXhDLE1BQU0rTSxTQUFTLEdBQUcsSUFBSSxDQUFDSCxZQUFZLEdBQUcsSUFBSTVCLElBQUksQ0FBQ0EsSUFBSSxDQUFDRCxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUksR0FBRyxJQUFJLENBQUM2QixZQUFZLENBQUMsR0FBRyxJQUFJO01BQzVGLElBQUksQ0FBQ0UsY0FBYyxHQUFHO1FBQUU5TSxTQUFTO1FBQUUrTTtNQUFVLENBQUM7TUFDOUM7TUFDQSxNQUFNQyxZQUFZLEdBQUc3UCxjQUFRLENBQUNKLEdBQUcsQ0FBQyxJQUFJLENBQUNDLGFBQWEsQ0FBQztNQUNyRCxJQUFJZ1EsWUFBWSxFQUFFO1FBQ2hCQSxZQUFZLENBQUNGLGNBQWMsR0FBRyxJQUFJLENBQUNBLGNBQWM7TUFDbkQ7TUFFQSxPQUFPLElBQUksQ0FBQ0EsY0FBYyxDQUFDOU0sU0FBUztJQUN0QztJQUVBLE9BQU8sSUFBSSxDQUFDQSxTQUFTO0VBQ3ZCO0VBRUEsSUFBSXVGLGFBQWFBLENBQUEsRUFBRztJQUNsQixPQUFPLElBQUksQ0FBQzlFLEtBQUssSUFBSSxJQUFJLENBQUNBLEtBQUssQ0FBQzhFLGFBQWEsR0FDekMsSUFBSSxDQUFDOUUsS0FBSyxDQUFDOEUsYUFBYSxHQUN4QixNQUFNO0VBQ1o7QUFDRjtBQUFDMEgsT0FBQSxDQUFBblEsTUFBQSxHQUFBQSxNQUFBO0FBQUEsSUFBQW9RLFFBQUEsR0FBQUQsT0FBQSxDQUFBMVEsT0FBQSxHQUVjTyxNQUFNO0FBQ3JCcVEsTUFBTSxDQUFDRixPQUFPLEdBQUduUSxNQUFNIiwiaWdub3JlTGlzdCI6W119