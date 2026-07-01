"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _RestQuery = _interopRequireDefault(require("./RestQuery"));
var _lodash = _interopRequireDefault(require("lodash"));
var _logger = _interopRequireDefault(require("./logger"));
var _SchemaController = require("./Controllers/SchemaController");
var _Error = require("./Error");
var _AuthDataLock = require("./AuthDataLock");
var InstallationDedup = _interopRequireWildcard(require("./InstallationDedup"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// A RestWrite encapsulates everything we need to run an operation
// that writes to the database.
// This could be either a "create" or an "update".

var SchemaController = require('./Controllers/SchemaController');
const Auth = require('./Auth');
const Utils = require('./Utils');
var cryptoUtils = require('./cryptoUtils');
var passwordCrypto = require('./password');
var Parse = require('parse/node');
var triggers = require('./triggers');
var ClientSDK = require('./ClientSDK');
const util = require('util');
// query and data are both provided in REST API format. So data
// types are encoded by plain old objects.
// If query is null, this is a "create" and the data in data should be
// created.
// Otherwise this is an "update" - the object matching the query
// should get updated with data.
// RestWrite will handle objectId, createdAt, and updatedAt for
// everything. It also knows to use triggers and special modifications
// for the _User class.
function RestWrite(config, auth, className, query, data, originalData, clientSDK, context, action) {
  if (auth.isReadOnly) {
    throw (0, _Error.createSanitizedError)(Parse.Error.OPERATION_FORBIDDEN, 'Cannot perform a write operation when using readOnlyMasterKey', config);
  }
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.clientSDK = clientSDK;
  this.storage = {};
  this.runOptions = {};
  this.context = context || {};
  if (action) {
    this.runOptions.action = action;
  }
  if (!query) {
    if (this.config.allowCustomObjectId) {
      if (Object.prototype.hasOwnProperty.call(data, 'objectId') && !data.objectId) {
        throw new Parse.Error(Parse.Error.MISSING_OBJECT_ID, 'objectId must not be empty, null or undefined');
      }
    } else {
      if (data.objectId) {
        throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'objectId is an invalid field name.');
      }
      if (data.id) {
        throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'id is an invalid field name.');
      }
    }
  }

  // When the operation is complete, this.response may have several
  // fields.
  // response: the actual data to be returned
  // status: the http status code. if not present, treated like a 200
  // location: the location header. if not present, no location header
  this.response = null;

  // Processing this operation may mutate our data, so we operate on a
  // copy
  this.query = structuredClone(query);
  this.data = structuredClone(data);
  // We never change originalData, so we do not need a deep copy
  this.originalData = originalData;

  // The timestamp we'll use for this whole operation
  this.updatedAt = Parse._encode(new Date()).iso;

  // Shared SchemaController to be reused to reduce the number of loadSchema() calls per request
  // Once set the schemaData should be immutable
  this.validSchemaController = null;
  this.pendingOps = {
    operations: null,
    identifier: null
  };
}

// A convenient method to perform all the steps of processing the
// write, in order.
// Returns a promise for a {response, status, location} object.
// status and location are optional.
RestWrite.prototype.execute = function () {
  return Promise.resolve().then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.handleInstallation();
  }).then(() => {
    return this.handleSession();
  }).then(() => {
    return this.validateAuthData();
  }).then(() => {
    return this.checkRestrictedFields();
  }).then(() => {
    return this.runBeforeSaveTrigger();
  }).then(() => {
    return this.ensureUniqueAuthDataId();
  }).then(() => {
    return this.deleteEmailResetTokenIfNeeded();
  }).then(() => {
    return this.validateSchema();
  }).then(schemaController => {
    this.validSchemaController = schemaController;
    return this.setRequiredFieldsIfNeeded();
  }).then(() => {
    return this.validateCreatePermission();
  }).then(() => {
    return this.transformUser();
  }).then(() => {
    return this.expandFilesForExistingObjects();
  }).then(() => {
    return this.destroyDuplicatedSessions();
  }).then(() => {
    return this.runDatabaseOperation();
  }).then(() => {
    return this.createSessionTokenIfNeeded();
  }).then(() => {
    return this.handleFollowup();
  }).then(() => {
    return this.runAfterSaveTrigger();
  }).then(() => {
    return this.cleanUserAuthData();
  }).then(() => {
    return this.filterProtectedFieldsInResponse();
  }).then(() => {
    // Append the authDataResponse if exists
    if (this.authDataResponse) {
      if (this.response && this.response.response) {
        this.response.response.authDataResponse = this.authDataResponse;
      }
    }
    if (this.storage.rejectSignup && this.config.preventSignupWithUnverifiedEmail) {
      throw new Parse.Error(Parse.Error.EMAIL_NOT_FOUND, 'User email is not verified.');
    }
    return this.response;
  });
};

// Uses the Auth object to get the list of roles, adds the user id
RestWrite.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return Promise.resolve();
  }
  this.runOptions.acl = ['*'];
  if (this.auth.user) {
    return this.auth.getUserRoles().then(roles => {
      this.runOptions.acl = this.runOptions.acl.concat(roles, [this.auth.user.id]);
      return;
    });
  } else {
    return Promise.resolve();
  }
};

// Validates this operation against the allowClientClassCreation config.
RestWrite.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && !this.auth.isMaintenance && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw (0, _Error.createSanitizedError)(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access non-existent class: ' + this.className, this.config);
      }
    });
  } else {
    return Promise.resolve();
  }
};

// Validates this operation against the schema.
RestWrite.prototype.validateSchema = function () {
  return this.config.database.validateObject(this.className, this.data, this.query, this.runOptions, this.auth.isMaintenance);
};

// Runs any beforeSave triggers against this operation.
// Any change leads to our data being mutated.
RestWrite.prototype.runBeforeSaveTrigger = function () {
  if (this.response || this.runOptions.many) {
    return;
  }

  // Avoid doing any setup for triggers if there is no 'beforeSave' trigger for this class.
  if (!triggers.triggerExists(this.className, triggers.Types.beforeSave, this.config.applicationId)) {
    return Promise.resolve();
  }
  const {
    originalObject,
    updatedObject
  } = this.buildParseObjects();
  const identifier = updatedObject._getStateIdentifier();
  const stateController = Parse.CoreManager.getObjectStateController();
  const [pending] = stateController.getPendingOps(identifier);
  this.pendingOps = {
    operations: {
      ...pending
    },
    identifier
  };
  return Promise.resolve().then(() => {
    // Before calling the trigger, validate the permissions for the save operation
    let databasePromise = null;
    if (this.query) {
      // Validate for updating
      databasePromise = this.config.database.update(this.className, this.query, this.data, this.runOptions, true, true);
    } else {
      // Validate for creating
      databasePromise = this.config.database.create(this.className, this.data, this.runOptions, true);
    }
    // In the case that there is no permission for the operation, it throws an error
    return databasePromise.then(result => {
      if (!result || result.length <= 0) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }
    });
  }).then(() => {
    return triggers.maybeRunTrigger(triggers.Types.beforeSave, this.auth, updatedObject, originalObject, this.config, this.context);
  }).then(response => {
    if (response && response.object) {
      this.storage.fieldsChangedByTrigger = _lodash.default.reduce(response.object, (result, value, key) => {
        if (!_lodash.default.isEqual(this.data[key], value)) {
          result.push(key);
        }
        return result;
      }, []);
      this.data = response.object;
      // We should delete the objectId for an update write
      if (this.query && this.query.objectId) {
        delete this.data.objectId;
      }
    }
    try {
      Utils.checkProhibitedKeywords(this.config, this.data);
    } catch (error) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, `${error}`);
    }
  });
};
RestWrite.prototype.runBeforeLoginTrigger = async function (userData) {
  // Avoid doing any setup for triggers if there is no 'beforeLogin' trigger
  if (!triggers.triggerExists(this.className, triggers.Types.beforeLogin, this.config.applicationId)) {
    return;
  }

  // Cloud code gets a bit of extra data for its objects
  const extraData = {
    className: this.className
  };

  // Expand file objects
  await this.config.filesController.expandFilesInObject(this.config, userData);
  const user = triggers.inflate(extraData, userData);

  // no need to return a response
  await triggers.maybeRunTrigger(triggers.Types.beforeLogin, this.auth, user, null, this.config, this.context);
};
RestWrite.prototype.setRequiredFieldsIfNeeded = function () {
  if (this.data) {
    return this.validSchemaController.getAllClasses().then(allClasses => {
      const schema = allClasses.find(oneClass => oneClass.className === this.className);
      const setRequiredFieldIfNeeded = (fieldName, setDefault) => {
        if (this.data[fieldName] === undefined || this.data[fieldName] === null || this.data[fieldName] === '' || typeof this.data[fieldName] === 'object' && this.data[fieldName].__op === 'Delete') {
          if (setDefault && schema.fields[fieldName] && schema.fields[fieldName].defaultValue !== null && schema.fields[fieldName].defaultValue !== undefined && (this.data[fieldName] === undefined || typeof this.data[fieldName] === 'object' && this.data[fieldName].__op === 'Delete')) {
            this.data[fieldName] = schema.fields[fieldName].defaultValue;
            this.storage.fieldsChangedByTrigger = this.storage.fieldsChangedByTrigger || [];
            if (this.storage.fieldsChangedByTrigger.indexOf(fieldName) < 0) {
              this.storage.fieldsChangedByTrigger.push(fieldName);
            }
          } else if (schema.fields[fieldName] && schema.fields[fieldName].required === true) {
            throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `${fieldName} is required`);
          }
        }
      };

      // add default ACL (only on CREATE, not UPDATE)
      if (!this.query && schema?.classLevelPermissions?.ACL && !this.data.ACL && JSON.stringify(schema.classLevelPermissions.ACL) !== JSON.stringify({
        '*': {
          read: true,
          write: true
        }
      })) {
        const acl = structuredClone(schema.classLevelPermissions.ACL);
        if (acl.currentUser) {
          if (this.auth.user?.id) {
            acl[this.auth.user?.id] = structuredClone(acl.currentUser);
          }
          delete acl.currentUser;
        }
        this.data.ACL = acl;
        this.storage.fieldsChangedByTrigger = this.storage.fieldsChangedByTrigger || [];
        this.storage.fieldsChangedByTrigger.push('ACL');
      }

      // Add default fields
      if (!this.query) {
        // allow customizing createdAt and updatedAt when using maintenance key
        if (this.auth.isMaintenance && this.data.createdAt && this.data.createdAt.__type === 'Date') {
          this.data.createdAt = this.data.createdAt.iso;
          if (this.data.updatedAt && this.data.updatedAt.__type === 'Date') {
            const createdAt = new Date(this.data.createdAt);
            const updatedAt = new Date(this.data.updatedAt.iso);
            if (updatedAt < createdAt) {
              throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'updatedAt cannot occur before createdAt');
            }
            this.data.updatedAt = this.data.updatedAt.iso;
          }
          // if no updatedAt is provided, set it to createdAt to match default behavior
          else {
            this.data.updatedAt = this.data.createdAt;
          }
        } else {
          this.data.updatedAt = this.updatedAt;
          this.data.createdAt = this.updatedAt;
        }

        // Only assign new objectId if we are creating new object
        if (!this.data.objectId) {
          this.data.objectId = cryptoUtils.newObjectId(this.config.objectIdSize);
        }
        if (schema) {
          Object.keys(schema.fields).forEach(fieldName => {
            setRequiredFieldIfNeeded(fieldName, true);
          });
        }
      } else if (schema) {
        this.data.updatedAt = this.updatedAt;
        Object.keys(this.data).forEach(fieldName => {
          setRequiredFieldIfNeeded(fieldName, false);
        });
      }
    });
  }
  return Promise.resolve();
};

// Transforms auth data for a user object.
// Does nothing if this isn't a user object.
// Returns a promise for when we're done if it can't finish this tick.
RestWrite.prototype.validateAuthData = function () {
  if (this.className !== '_User') {
    return;
  }
  const authData = this.data.authData;
  const hasUsernameAndPassword = typeof this.data.username === 'string' && typeof this.data.password === 'string';
  const hasAuthData = authData && Object.keys(authData).some(provider => {
    const providerData = authData[provider];
    return providerData && typeof providerData === 'object' && Object.keys(providerData).length;
  });
  if (!this.query && !hasAuthData) {
    if (typeof this.data.username !== 'string' || _lodash.default.isEmpty(this.data.username)) {
      throw new Parse.Error(Parse.Error.USERNAME_MISSING, 'bad or missing username');
    }
    if (typeof this.data.password !== 'string' || _lodash.default.isEmpty(this.data.password)) {
      throw new Parse.Error(Parse.Error.PASSWORD_MISSING, 'password is required');
    }
  }
  if (!Object.prototype.hasOwnProperty.call(this.data, 'authData')) {
    // Nothing to validate here
    return;
  } else if (!this.data.authData) {
    // Handle saving authData to null
    throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
  }
  var providers = Object.keys(authData);
  if (!providers.length) {
    // Empty authData object, nothing to validate
    return;
  }
  const canHandleAuthData = providers.some(provider => {
    const providerAuthData = authData[provider] || {};
    return !!Object.keys(providerAuthData).length;
  });
  if (canHandleAuthData || hasUsernameAndPassword || this.auth.isMaster || this.getUserId()) {
    return this.handleAuthData(authData);
  }
  throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
};
RestWrite.prototype.filteredObjectsByACL = function (objects) {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return objects;
  }
  return objects.filter(object => {
    if (!object.ACL) {
      return true; // legacy users that have no ACL field on them
    }
    // Regular users that have been locked out.
    return object.ACL && Object.keys(object.ACL).length > 0;
  });
};
RestWrite.prototype.getUserId = function () {
  if (this.query && this.query.objectId && this.className === '_User') {
    return this.query.objectId;
  } else if (this.auth && this.auth.user && this.auth.user.id) {
    return this.auth.user.id;
  }
};

// Developers are allowed to change authData via before save trigger
RestWrite.prototype._throwIfAuthDataDuplicate = function (error) {
  if (this.className === '_User' && error?.code === Parse.Error.DUPLICATE_VALUE && error.userInfo?.duplicated_field?.startsWith('_auth_data_')) {
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }
};

// we need after before save to ensure that the developer
// is not currently duplicating auth data ID
RestWrite.prototype.ensureUniqueAuthDataId = async function () {
  if (this.className !== '_User' || !this.data.authData) {
    return;
  }
  const hasAuthDataId = Object.keys(this.data.authData).some(key => this.data.authData[key] && this.data.authData[key].id);
  if (!hasAuthDataId) {
    return;
  }
  const r = await Auth.findUsersWithAuthData(this.config, this.data.authData);
  const results = this.filteredObjectsByACL(r);
  if (results.length > 1) {
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }
  // use data.objectId in case of login time and found user during handle validateAuthData
  const userId = this.getUserId() || this.data.objectId;
  if (results.length === 1 && userId !== results[0].objectId) {
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }
};
RestWrite.prototype.handleAuthData = async function (authData) {
  let currentUserAuthData;
  if (this.query?.objectId) {
    const [currentUser] = await this.config.database.find('_User', {
      objectId: this.query.objectId
    });
    currentUserAuthData = currentUser?.authData;
  }
  const r = await Auth.findUsersWithAuthData(this.config, authData, true, currentUserAuthData);
  const results = this.filteredObjectsByACL(r);
  const userId = this.getUserId();
  const userResult = results[0];
  const foundUserIsNotCurrentUser = userId && userResult && userId !== userResult.objectId;
  if (results.length > 1 || foundUserIsNotCurrentUser) {
    // To avoid https://github.com/parse-community/parse-server/security/advisories/GHSA-8w3j-g983-8jh5
    // Let's run some validation before throwing
    await Auth.handleAuthDataValidation(authData, this, userResult);
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }

  // No user found with provided authData we need to validate
  if (!results.length) {
    const {
      authData: validatedAuthData,
      authDataResponse
    } = await Auth.handleAuthDataValidation(authData, this);
    this.authDataResponse = authDataResponse;
    // Replace current authData by the new validated one
    this.data.authData = validatedAuthData;
    return;
  }

  // User found with provided authData
  if (results.length === 1) {
    this.storage.authProvider = Object.keys(authData).join(',');
    const {
      hasMutatedAuthData,
      mutatedAuthData
    } = Auth.hasMutatedAuthData(authData, userResult.authData);
    const isCurrentUserLoggedOrMaster = this.auth && this.auth.user && this.auth.user.id === userResult.objectId || this.auth.isMaster;
    const isLogin = !userId;
    if (isLogin || isCurrentUserLoggedOrMaster) {
      // no user making the call
      // OR the user making the call is the right one
      // Login with auth data
      delete results[0].password;

      // need to set the objectId first otherwise location has trailing undefined
      this.data.objectId = userResult.objectId;
      if (!this.query || !this.query.objectId) {
        this.response = {
          response: userResult,
          location: this.location()
        };
        // Run beforeLogin hook before storing any updates
        // to authData on the db; changes to userResult
        // will be ignored.
        await this.runBeforeLoginTrigger(structuredClone(userResult));

        // If we are in login operation via authData
        // we need to be sure that the user has provided
        // required authData
        Auth.checkIfUserHasProvidedConfiguredProvidersForLogin({
          config: this.config,
          auth: this.auth
        }, authData, userResult.authData, this.config);
      }

      // Prevent validating if no mutated data detected on update
      if (!hasMutatedAuthData && isCurrentUserLoggedOrMaster) {
        return;
      }

      // Always validate all provided authData on login to prevent authentication
      // bypass via partial authData (e.g. sending only the provider ID without
      // an access token); on update only validate mutated ones
      if (isLogin || hasMutatedAuthData || !this.config.allowExpiredAuthDataToken) {
        const res = await Auth.handleAuthDataValidation(isLogin ? authData : mutatedAuthData, this, userResult);
        this.data.authData = res.authData;
        this.authDataResponse = res.authDataResponse;
      }

      // Capture original authData before mutating userResult via the response reference
      const originalAuthData = userResult?.authData ? Object.fromEntries(Object.entries(userResult.authData).map(([k, v]) => [k, v && typeof v === 'object' ? {
        ...v
      } : v])) : undefined;

      // IF we are in login we'll skip the database operation / beforeSave / afterSave etc...
      // we need to set it up there.
      // We are supposed to have a response only on LOGIN with authData, so we skip those
      // If we're not logging in, but just updating the current user, we can safely skip that part
      if (this.response) {
        // Assign the new authData in the response
        Object.keys(mutatedAuthData).forEach(provider => {
          this.response.response.authData[provider] = mutatedAuthData[provider];
        });

        // Run the DB update directly, as 'master' only if authData contains some keys
        // authData could not contains keys after validation if the authAdapter
        // uses the `doNotSave` option. Just update the authData part
        // Then we're good for the user, early exit of sorts
        if (Object.keys(this.data.authData).length) {
          const query = {
            objectId: this.data.objectId
          };
          // Optimistic locking: include each changed original field in the WHERE clause
          // for providers whose data is being updated. This prevents concurrent requests
          // from both succeeding when consuming single-use tokens (e.g. MFA recovery codes
          // as arrays, or MFA SMS OTP tokens as strings).
          (0, _AuthDataLock.applyAuthDataOptimisticLock)(query, originalAuthData, this.data.authData);
          try {
            await this.config.database.update(this.className, query, {
              authData: this.data.authData
            }, {});
          } catch (error) {
            if (error.code === Parse.Error.OBJECT_NOT_FOUND) {
              throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Invalid auth data');
            }
            this._throwIfAuthDataDuplicate(error);
            throw error;
          }
        }
      } else if (this.query && this.data.authData && Object.keys(this.data.authData).length) {
        // UPDATE path (e.g. PUT /users/:id during linked-provider re-auth): apply
        // the same optimistic lock to the subsequent runDatabaseOperation update so
        // concurrent single-use token consumers cannot both succeed.
        (0, _AuthDataLock.applyAuthDataOptimisticLock)(this.query, originalAuthData, this.data.authData);
      }
    }
  }
};
RestWrite.prototype.checkRestrictedFields = async function () {
  if (this.className !== '_User') {
    return;
  }
  if (!this.auth.isMaintenance && !this.auth.isMaster && 'emailVerified' in this.data) {
    throw (0, _Error.createSanitizedError)(Parse.Error.OPERATION_FORBIDDEN, "Clients aren't allowed to manually update email verification.", this.config);
  }
};

// Validates the create class-level permission before transformUser runs.
// This prevents user enumeration (username/email existence) when public
// create is disabled on _User, because transformUser checks uniqueness
// before the CLP is enforced in runDatabaseOperation.
RestWrite.prototype.validateCreatePermission = async function () {
  if (this.query || this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  if (!this.validSchemaController) {
    return;
  }
  await this.validSchemaController.validatePermission(this.className, this.runOptions.acl || [], 'create');
};

// The non-third-party parts of User transformation
RestWrite.prototype.transformUser = async function () {
  var promise = Promise.resolve();
  if (this.className !== '_User') {
    return promise;
  }

  // Do not cleanup session if objectId is not set
  if (this.query && this.objectId()) {
    // If we're updating a _User object, we need to clear out the cache for that user. Find all their
    // session tokens, and remove them from the cache.
    const query = await (0, _RestQuery.default)({
      method: _RestQuery.default.Method.find,
      config: this.config,
      auth: Auth.master(this.config),
      className: '_Session',
      runBeforeFind: false,
      restWhere: {
        user: {
          __type: 'Pointer',
          className: '_User',
          objectId: this.objectId()
        }
      }
    });
    promise = query.execute().then(results => {
      results.results.forEach(session => this.config.cacheController.user.del(session.sessionToken));
    });
  }
  return promise.then(() => {
    // Transform the password
    if (this.data.password === undefined) {
      // ignore only if undefined. should proceed if empty ('')
      return Promise.resolve();
    }
    if (this.query) {
      this.storage['clearSessions'] = true;
      // Generate a new session only if the user requested
      if (!this.auth.isMaster && !this.auth.isMaintenance) {
        this.storage['generateNewSession'] = true;
      }
    }
    return this._validatePasswordPolicy().then(() => {
      return passwordCrypto.hash(this.data.password).then(hashedPassword => {
        this.data._hashed_password = hashedPassword;
        delete this.data.password;
      });
    });
  }).then(() => {
    return this._validateUserName();
  }).then(() => {
    return this._validateEmail();
  });
};
RestWrite.prototype._validateUserName = function () {
  // Check for username uniqueness
  if (!this.data.username) {
    if (!this.query) {
      this.data.username = cryptoUtils.randomString(25);
      this.responseShouldHaveUsername = true;
    }
    return Promise.resolve();
  }
  /*
    Usernames should be unique when compared case insensitively
     Users should be able to make case sensitive usernames and
    login using the case they entered.  I.e. 'Snoopy' should preclude
    'snoopy' as a valid username.
  */
  return this.config.database.find(this.className, {
    username: this.data.username,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1,
    caseInsensitive: true
  }, {}, this.validSchemaController).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
    }
    return;
  });
};
RestWrite.buildCreatedWith = function (action, authProvider) {
  return {
    action,
    authProvider: authProvider || 'password'
  };
};
RestWrite.prototype.getCreatedWith = function () {
  if (this.storage.createdWith) {
    return this.storage.createdWith;
  }
  const isCreateOperation = !this.query;
  const authDataProvider = this.data?.authData && Object.keys(this.data.authData).length && Object.keys(this.data.authData).join(',');
  const authProvider = this.storage.authProvider || authDataProvider;
  // storage.authProvider is only set for login (existing user found in handleAuthData)
  const action = this.storage.authProvider ? 'login' : isCreateOperation ? 'signup' : undefined;
  if (!action) {
    return;
  }
  const resolvedAuthProvider = authProvider || (action === 'signup' ? 'password' : undefined);
  this.storage.createdWith = RestWrite.buildCreatedWith(action, resolvedAuthProvider);
  return this.storage.createdWith;
};

/*
  As with usernames, Parse should not allow case insensitive collisions of email.
  unlike with usernames (which can have case insensitive collisions in the case of
  auth adapters), emails should never have a case insensitive collision.

  This behavior can be enforced through a properly configured index see:
  https://docs.mongodb.com/manual/core/index-case-insensitive/#create-a-case-insensitive-index
  which could be implemented instead of this code based validation.

  Given that this lookup should be a relatively low use case and that the case sensitive
  unique index will be used by the db for the query, this is an adequate solution.
*/
RestWrite.prototype._validateEmail = function () {
  if (!this.data.email || this.data.email.__op === 'Delete') {
    return Promise.resolve();
  }
  // Validate basic email address format
  if (!this.data.email.match(/^.+@.+$/)) {
    return Promise.reject(new Parse.Error(Parse.Error.INVALID_EMAIL_ADDRESS, 'Email address format is invalid.'));
  }
  // Case insensitive match, see note above function.
  return this.config.database.find(this.className, {
    email: this.data.email,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1,
    caseInsensitive: true
  }, {}, this.validSchemaController).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
    }
    if (!this.data.authData || !Object.keys(this.data.authData).length || Object.keys(this.data.authData).length === 1 && Object.keys(this.data.authData)[0] === 'anonymous') {
      // We updated the email, send a new validation
      const {
        originalObject,
        updatedObject
      } = this.buildParseObjects();
      const request = {
        original: originalObject,
        object: updatedObject,
        master: this.auth.isMaster,
        ip: this.config.ip,
        installationId: this.auth.installationId,
        createdWith: this.getCreatedWith()
      };
      return this.config.userController.setEmailVerifyToken(this.data, request, this.storage);
    }
  });
};
RestWrite.prototype._validatePasswordPolicy = function () {
  if (!this.config.passwordPolicy) {
    return Promise.resolve();
  }
  return this._validatePasswordRequirements().then(() => {
    return this._validatePasswordHistory();
  });
};
RestWrite.prototype._validatePasswordRequirements = function () {
  // check if the password conforms to the defined password policy if configured
  // If we specified a custom error in our configuration use it.
  // Example: "Passwords must include a Capital Letter, Lowercase Letter, and a number."
  //
  // This is especially useful on the generic "password reset" page,
  // as it allows the programmer to communicate specific requirements instead of:
  // a. making the user guess whats wrong
  // b. making a custom password reset page that shows the requirements
  const policyError = this.config.passwordPolicy.validationError ? this.config.passwordPolicy.validationError : 'Password does not meet the Password Policy requirements.';
  const containsUsernameError = 'Password cannot contain your username.';

  // check whether the password meets the password strength requirements
  if (this.config.passwordPolicy.patternValidator && !this.config.passwordPolicy.patternValidator(this.data.password) || this.config.passwordPolicy.validatorCallback && !this.config.passwordPolicy.validatorCallback(this.data.password)) {
    return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, policyError));
  }

  // check whether password contain username
  if (this.config.passwordPolicy.doNotAllowUsername === true) {
    if (this.data.username) {
      // username is not passed during password reset
      if (this.data.password.indexOf(this.data.username) >= 0) {
        return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
      }
    } else {
      // retrieve the User object using objectId during password reset
      return this.config.database.find('_User', {
        objectId: this.objectId()
      }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }
        if (this.data.password.indexOf(results[0].username) >= 0) {
          return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
        }
        return Promise.resolve();
      });
    }
  }
  return Promise.resolve();
};
RestWrite.prototype._validatePasswordHistory = function () {
  // check whether password is repeating from specified history
  if (this.query && this.config.passwordPolicy.maxPasswordHistory) {
    return this.config.database.find('_User', {
      objectId: this.objectId()
    }, {
      keys: ['_password_history', '_hashed_password']
    }, Auth.maintenance(this.config)).then(results => {
      if (results.length != 1) {
        throw undefined;
      }
      const user = results[0];
      let oldPasswords = [];
      if (user._password_history) {
        oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory - 1);
      }
      oldPasswords.push(user.password);
      const newPassword = this.data.password;
      // compare the new password hash with all old password hashes
      const promises = oldPasswords.map(function (hash) {
        return passwordCrypto.compare(newPassword, hash).then(result => {
          if (result)
            // reject if there is a match
            {
              return Promise.reject('REPEAT_PASSWORD');
            }
          return Promise.resolve();
        });
      });
      // wait for all comparisons to complete
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      }).catch(err => {
        if (err === 'REPEAT_PASSWORD')
          // a match was found
          {
            return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, `New password should not be the same as last ${this.config.passwordPolicy.maxPasswordHistory} passwords.`));
          }
        throw err;
      });
    });
  }
  return Promise.resolve();
};
RestWrite.prototype.createSessionTokenIfNeeded = async function () {
  if (this.className !== '_User') {
    return;
  }
  // Don't generate session for updating user (this.query is set) unless authData exists
  if (this.query && !this.data.authData) {
    return;
  }
  // Don't generate new sessionToken if linking via sessionToken
  if (this.auth.user && this.data.authData) {
    return;
  }
  // If sign-up call
  if (!this.storage.authProvider) {
    // Create request object for verification functions
    const {
      originalObject,
      updatedObject
    } = this.buildParseObjects();
    const request = {
      original: originalObject,
      object: updatedObject,
      master: this.auth.isMaster,
      ip: this.config.ip,
      installationId: this.auth.installationId,
      createdWith: this.getCreatedWith()
    };
    // Get verification conditions which can be booleans or functions; the purpose of this async/await
    // structure is to avoid unnecessarily executing subsequent functions if previous ones fail in the
    // conditional statement below, as a developer may decide to execute expensive operations in them
    const verifyUserEmails = async () => this.config.verifyUserEmails === true || typeof this.config.verifyUserEmails === 'function' && (await Promise.resolve(this.config.verifyUserEmails(request))) === true;
    const preventLoginWithUnverifiedEmail = async () => this.config.preventLoginWithUnverifiedEmail === true || typeof this.config.preventLoginWithUnverifiedEmail === 'function' && (await Promise.resolve(this.config.preventLoginWithUnverifiedEmail(request))) === true;
    // If verification is required
    if ((await verifyUserEmails()) && (await preventLoginWithUnverifiedEmail())) {
      this.storage.rejectSignup = true;
      return;
    }
  }
  return this.createSessionToken();
};
RestWrite.prototype.createSessionToken = async function () {
  // cloud installationId from Cloud Code,
  // never create session tokens from there.
  if (this.auth.installationId && this.auth.installationId === 'cloud') {
    return;
  }
  if (this.storage.authProvider == null && this.data.authData) {
    this.storage.authProvider = Object.keys(this.data.authData).join(',');
    // Invalidate cached createdWith since authProvider was just resolved
    delete this.storage.createdWith;
  }
  const createdWith = this.getCreatedWith();
  const {
    sessionData,
    createSession
  } = RestWrite.createSession(this.config, {
    userId: this.objectId(),
    createdWith,
    installationId: this.auth.installationId
  });
  if (this.response && this.response.response) {
    this.response.response.sessionToken = sessionData.sessionToken;
  }
  return createSession();
};
RestWrite.createSession = function (config, {
  userId,
  createdWith,
  installationId,
  additionalSessionData
}) {
  const token = 'r:' + cryptoUtils.newToken();
  const expiresAt = config.generateSessionExpiresAt();
  const sessionData = {
    sessionToken: token,
    user: {
      __type: 'Pointer',
      className: '_User',
      objectId: userId
    },
    createdWith,
    expiresAt: Parse._encode(expiresAt)
  };
  if (installationId) {
    sessionData.installationId = installationId;
  }
  Object.assign(sessionData, additionalSessionData);
  return {
    sessionData,
    createSession: () => new RestWrite(config, Auth.master(config), '_Session', null, sessionData).execute()
  };
};

// Delete email reset tokens if user is changing password or email.
RestWrite.prototype.deleteEmailResetTokenIfNeeded = function () {
  if (this.className !== '_User' || this.query === null) {
    // null query means create
    return;
  }
  if ('password' in this.data || 'email' in this.data) {
    const addOps = {
      _perishable_token: {
        __op: 'Delete'
      },
      _perishable_token_expires_at: {
        __op: 'Delete'
      }
    };
    this.data = Object.assign(this.data, addOps);
  }
};
RestWrite.prototype.destroyDuplicatedSessions = function () {
  // Only for _Session, and at creation time
  if (this.className != '_Session' || this.query) {
    return;
  }
  // Destroy the sessions in 'Background'
  const {
    user,
    installationId,
    sessionToken
  } = this.data;
  if (!user || !installationId) {
    return;
  }
  if (!user.objectId) {
    return;
  }
  return this.config.database.destroy('_Session', {
    user,
    installationId,
    sessionToken: {
      $ne: sessionToken
    }
  }, {}, this.validSchemaController).catch(e => {
    if (e.code !== Parse.Error.OBJECT_NOT_FOUND) {
      throw e;
    }
  });
};

// Handles any followup logic
RestWrite.prototype.handleFollowup = function () {
  if (this.storage && this.storage['clearSessions'] && this.config.revokeSessionOnPasswordReset) {
    var sessionQuery = {
      user: {
        __type: 'Pointer',
        className: '_User',
        objectId: this.objectId()
      }
    };
    delete this.storage['clearSessions'];
    return this.config.database.destroy('_Session', sessionQuery).then(this.handleFollowup.bind(this));
  }
  if (this.storage && this.storage['generateNewSession']) {
    delete this.storage['generateNewSession'];
    return this.createSessionToken().then(this.handleFollowup.bind(this));
  }
  if (this.storage && this.storage['sendVerificationEmail']) {
    delete this.storage['sendVerificationEmail'];
    // Fire and forget!
    this.config.userController.sendVerificationEmail(this.data, {
      auth: this.auth
    });
    return this.handleFollowup.bind(this);
  }
};

// Handles the _Session class specialness.
// Does nothing if this isn't an _Session object.
RestWrite.prototype.handleSession = function () {
  if (this.response || this.className !== '_Session') {
    return;
  }
  if (!this.auth.user && !this.auth.isMaster && !this.auth.isMaintenance) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token required.');
  }

  // TODO: Verify proper error to throw
  if ('ACL' in this.data) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Cannot set ' + 'ACL on a Session.');
  }
  if (this.query) {
    if ('user' in this.data && !this.auth.isMaster && this.data.user?.objectId !== this.auth.user.id) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Invalid key name: user');
    } else if ('installationId' in this.data) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Invalid key name: installationId');
    } else if ('sessionToken' in this.data) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Invalid key name: sessionToken');
    } else if ('expiresAt' in this.data && !this.auth.isMaster && !this.auth.isMaintenance) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Invalid key name: expiresAt');
    } else if ('createdWith' in this.data && !this.auth.isMaster && !this.auth.isMaintenance) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Invalid key name: createdWith');
    }
    if (!this.auth.isMaster) {
      this.query = {
        $and: [this.query, {
          user: {
            __type: 'Pointer',
            className: '_User',
            objectId: this.auth.user.id
          }
        }]
      };
    }
  }
  if (!this.query && !this.auth.isMaster && !this.auth.isMaintenance) {
    const additionalSessionData = {};
    for (var key in this.data) {
      if (key === 'objectId' || key === 'user' || key === 'sessionToken' || key === 'expiresAt' || key === 'createdWith') {
        continue;
      }
      additionalSessionData[key] = this.data[key];
    }
    const {
      sessionData,
      createSession
    } = RestWrite.createSession(this.config, {
      userId: this.auth.user.id,
      createdWith: {
        action: 'create'
      },
      additionalSessionData
    });
    return createSession().then(results => {
      if (!results.response) {
        throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Error creating session.');
      }
      sessionData['objectId'] = results.response['objectId'];
      this.response = {
        status: 201,
        location: results.location,
        response: sessionData
      };
    });
  }
};

// Handles the _Installation class specialness.
// Does nothing if this isn't an installation object.
// If an installation is found, this can mutate this.query and turn a create
// into an update.
// Returns a promise for when we're done if it can't finish this tick.
RestWrite.prototype.handleInstallation = function () {
  if (this.response || this.className !== '_Installation') {
    return;
  }
  if (!this.query && !this.data.deviceToken && !this.data.installationId && !this.auth.installationId) {
    throw new Parse.Error(135, 'at least one ID field (deviceToken, installationId) ' + 'must be specified in this operation');
  }

  // If the device token is 64 characters long, we assume it is for iOS
  // and lowercase it.
  if (this.data.deviceToken && this.data.deviceToken.length == 64) {
    this.data.deviceToken = this.data.deviceToken.toLowerCase();
  }

  // We lowercase the installationId if present
  if (this.data.installationId) {
    this.data.installationId = this.data.installationId.toLowerCase();
  }
  let installationId = this.data.installationId;

  // If data.installationId is not set and we're not master, we can lookup in auth
  if (!installationId && !this.auth.isMaster && !this.auth.isMaintenance) {
    installationId = this.auth.installationId;
  }
  if (installationId) {
    installationId = installationId.toLowerCase();
  }

  // Updating _Installation but not updating anything critical
  if (this.query && !this.data.deviceToken && !installationId && !this.data.deviceType) {
    return;
  }
  var promise = Promise.resolve();
  var idMatch; // Will be a match on either objectId or installationId
  var objectIdMatch;
  var installationIdMatch;
  var deviceTokenMatches = [];

  // Instead of issuing 3 reads, let's do it with one OR.
  const orQueries = [];
  if (this.query && this.query.objectId) {
    orQueries.push({
      objectId: this.query.objectId
    });
  }
  if (installationId) {
    orQueries.push({
      installationId: installationId
    });
  }
  if (this.data.deviceToken) {
    orQueries.push({
      deviceToken: this.data.deviceToken
    });
  }
  if (orQueries.length == 0) {
    return;
  }
  promise = promise.then(() => {
    return this.config.database.find('_Installation', {
      $or: orQueries
    }, {});
  }).then(results => {
    results.forEach(result => {
      if (this.query && this.query.objectId && result.objectId == this.query.objectId) {
        objectIdMatch = result;
      }
      if (result.installationId == installationId) {
        installationIdMatch = result;
      }
      if (result.deviceToken == this.data.deviceToken) {
        deviceTokenMatches.push(result);
      }
    });

    // Sanity checks when running a query
    if (this.query && this.query.objectId) {
      if (!objectIdMatch) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found for update.');
      }
      if (this.data.installationId && objectIdMatch.installationId && this.data.installationId !== objectIdMatch.installationId) {
        throw new Parse.Error(136, 'installationId may not be changed in this ' + 'operation');
      }
      if (this.data.deviceToken && objectIdMatch.deviceToken && this.data.deviceToken !== objectIdMatch.deviceToken && !this.data.installationId && !objectIdMatch.installationId) {
        throw new Parse.Error(136, 'deviceToken may not be changed in this ' + 'operation');
      }
      if (this.data.deviceType && this.data.deviceType && this.data.deviceType !== objectIdMatch.deviceType) {
        throw new Parse.Error(136, 'deviceType may not be changed in this ' + 'operation');
      }
    }
    if (this.query && this.query.objectId && objectIdMatch) {
      idMatch = objectIdMatch;
    }
    if (installationId && installationIdMatch) {
      idMatch = installationIdMatch;
    }
    // need to specify deviceType only if it's new
    if (!this.query && !this.data.deviceType && !idMatch) {
      throw new Parse.Error(135, 'deviceType must be specified in this operation');
    }
  }).then(() => {
    if (!idMatch) {
      if (!deviceTokenMatches.length) {
        return;
      } else if (deviceTokenMatches.length == 1 && (!deviceTokenMatches[0]['installationId'] || !installationId)) {
        // Single match on device token but none on installationId, and either
        // the passed object or the match is missing an installationId, so we
        // can just return the match.
        return deviceTokenMatches[0]['objectId'];
      } else if (!this.data.installationId) {
        throw new Parse.Error(132, 'Must specify installationId when deviceToken ' + 'matches multiple Installation objects');
      } else {
        // Multiple device token matches and we specified an installation ID,
        // or a single match where both the passed and matching objects have
        // an installation ID. Clean out other installations that match the
        // deviceToken, and return nil to signal that a new object should be
        // created.
        const delQuery = {
          deviceToken: this.data.deviceToken,
          installationId: {
            $ne: installationId
          }
        };
        if (this.data.appIdentifier) {
          delQuery['appIdentifier'] = this.data.appIdentifier;
        }
        const installationOpts = this.config.installation || {};
        return InstallationDedup.removeConflictingDeviceToken({
          database: this.config.database,
          query: delQuery,
          action: installationOpts.duplicateDeviceTokenAction || 'delete',
          enforceAuth: installationOpts.duplicateDeviceTokenActionEnforceAuth === true,
          runOptions: this.runOptions,
          validSchemaController: this.validSchemaController
        });
      }
    } else {
      if (deviceTokenMatches.length == 1 && !deviceTokenMatches[0]['installationId']) {
        // Exactly one device token match and it doesn't have an installation
        // ID. The two rows represent the same install; resolve the merge per
        // the configured options.
        const installationOpts = this.config.installation || {};
        return InstallationDedup.applyDuplicateDeviceTokenMerge({
          database: this.config.database,
          idMatch,
          deviceTokenMatch: deviceTokenMatches[0],
          action: installationOpts.duplicateDeviceTokenAction || 'delete',
          mergePriority: installationOpts.duplicateDeviceTokenMergePriority || 'deviceToken',
          enforceAuth: installationOpts.duplicateDeviceTokenActionEnforceAuth === true,
          runOptions: this.runOptions,
          validSchemaController: this.validSchemaController
        });
      } else {
        if (this.data.deviceToken && idMatch.deviceToken != this.data.deviceToken) {
          // We're setting the device token on an existing installation, so
          // we should try cleaning out old installations that match this
          // device token.
          const delQuery = {
            deviceToken: this.data.deviceToken
          };
          // We have a unique install Id, use that to preserve
          // the interesting installation
          if (this.data.installationId) {
            delQuery['installationId'] = {
              $ne: this.data.installationId
            };
          } else if (idMatch.objectId && this.data.objectId && idMatch.objectId == this.data.objectId) {
            // we passed an objectId, preserve that instalation
            delQuery['objectId'] = {
              $ne: idMatch.objectId
            };
          } else {
            // What to do here? can't really clean up everything...
            return idMatch.objectId;
          }
          if (this.data.appIdentifier) {
            delQuery['appIdentifier'] = this.data.appIdentifier;
          }
          const installationOpts = this.config.installation || {};
          return InstallationDedup.removeConflictingDeviceToken({
            database: this.config.database,
            query: delQuery,
            action: installationOpts.duplicateDeviceTokenAction || 'delete',
            enforceAuth: installationOpts.duplicateDeviceTokenActionEnforceAuth === true,
            runOptions: this.runOptions,
            validSchemaController: this.validSchemaController
          }).then(() => idMatch.objectId);
        }
        // In non-merge scenarios, just return the installation match id
        return idMatch.objectId;
      }
    }
  }).then(objId => {
    if (objId) {
      this.query = {
        objectId: objId
      };
      delete this.data.objectId;
      delete this.data.createdAt;
    }
    // TODO: Validate ops (add/remove on channels, $inc on badge, etc.)
  });
  return promise;
};

// If we short-circuited the object response - then we need to make sure we expand all the files,
// since this might not have a query, meaning it won't return the full result back.
// TODO: (nlutsenko) This should die when we move to per-class based controllers on _Session/_User
RestWrite.prototype.expandFilesForExistingObjects = async function () {
  // Check whether we have a short-circuited response - only then run expansion.
  if (this.response && this.response.response) {
    await this.config.filesController.expandFilesInObject(this.config, this.response.response);
  }
};
RestWrite.prototype.runDatabaseOperation = function () {
  if (this.response) {
    return;
  }
  if (this.className === '_Role') {
    if (this.data && this.data.users && this.data.users.objects) {
      this.data.users.objects.forEach(({
        objectId
      }) => this.config.cacheController.role.del(objectId));
    } else {
      this.config.cacheController.role.clear();
      if (this.config.liveQueryController) {
        this.config.liveQueryController.clearCachedRoles(this.auth.user);
      }
    }
  }
  if (this.className === '_User' && this.query && this.auth.isUnauthenticated()) {
    throw (0, _Error.createSanitizedError)(Parse.Error.SESSION_MISSING, `Cannot modify user ${this.query.objectId}.`, this.config);
  }
  if (this.className === '_Product' && this.data.download) {
    this.data.downloadName = this.data.download.name;
  }

  // TODO: Add better detection for ACL, ensuring a user can't be locked from
  //       their own user record.
  if (this.data.ACL && this.data.ACL['*unresolved']) {
    throw new Parse.Error(Parse.Error.INVALID_ACL, 'Invalid ACL.');
  }
  if (this.query) {
    // Force the user to not lockout
    // Matched with parse.com
    if (this.className === '_User' && this.data.ACL && this.auth.isMaster !== true && this.auth.isMaintenance !== true) {
      this.data.ACL[this.query.objectId] = {
        read: true,
        write: true
      };
    }
    // update password timestamp if user password is being changed
    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
      this.data._password_changed_at = Parse._encode(new Date());
    }
    // Ignore createdAt when update
    delete this.data.createdAt;
    let defer = Promise.resolve();
    // if password history is enabled then save the current password to history
    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordHistory) {
      defer = this.config.database.find('_User', {
        objectId: this.objectId()
      }, {
        keys: ['_password_history', '_hashed_password']
      }, Auth.maintenance(this.config)).then(results => {
        if (results.length != 1) {
          throw undefined;
        }
        const user = results[0];
        let oldPasswords = [];
        if (user._password_history) {
          oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory);
        }
        //n-1 passwords go into history including last password
        while (oldPasswords.length > Math.max(0, this.config.passwordPolicy.maxPasswordHistory - 2)) {
          oldPasswords.shift();
        }
        oldPasswords.push(user.password);
        this.data._password_history = oldPasswords;
      });
    }
    return defer.then(() => {
      // Run an update
      return this.config.database.update(this.className, this.query, this.data, this.runOptions, false, false, this.validSchemaController).catch(error => {
        this._throwIfAuthDataDuplicate(error);
        throw error;
      }).then(response => {
        response.updatedAt = this.updatedAt;
        this._updateResponseWithData(response, this.data);
        this.response = {
          response
        };
      });
    });
  } else {
    // Set the default ACL and password timestamp for the new _User
    if (this.className === '_User') {
      var ACL = this.data.ACL;
      // default public r/w ACL
      if (!ACL) {
        ACL = {};
        if (!this.config.enforcePrivateUsers) {
          ACL['*'] = {
            read: true,
            write: false
          };
        }
      }
      // make sure the user is not locked down
      ACL[this.data.objectId] = {
        read: true,
        write: true
      };
      this.data.ACL = ACL;
      // password timestamp to be used when password expiry policy is enforced
      if (this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
        this.data._password_changed_at = Parse._encode(new Date());
      }
    }

    // Run a create
    return this.config.database.create(this.className, this.data, this.runOptions, false, this.validSchemaController).catch(error => {
      if (this.className !== '_User' || error.code !== Parse.Error.DUPLICATE_VALUE) {
        throw error;
      }
      this._throwIfAuthDataDuplicate(error);

      // Quick check, if we were able to infer the duplicated field name
      if (error && error.userInfo && error.userInfo.duplicated_field === 'username') {
        throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
      }
      if (error && error.userInfo && error.userInfo.duplicated_field === 'email') {
        throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
      }

      // If this was a failed user creation due to username or email already taken, we need to
      // check whether it was username or email and return the appropriate error.
      // Fallback to the original method
      // TODO: See if we can later do this without additional queries by using named indexes.
      return this.config.database.find(this.className, {
        username: this.data.username,
        objectId: {
          $ne: this.objectId()
        }
      }, {
        limit: 1
      }).then(results => {
        if (results.length > 0) {
          throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
        }
        return this.config.database.find(this.className, {
          email: this.data.email,
          objectId: {
            $ne: this.objectId()
          }
        }, {
          limit: 1
        });
      }).then(results => {
        if (results.length > 0) {
          throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
        }
        throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      });
    }).then(response => {
      response.objectId = this.data.objectId;
      response.createdAt = this.data.createdAt;
      if (this.responseShouldHaveUsername) {
        response.username = this.data.username;
      }
      this._updateResponseWithData(response, this.data);
      this.response = {
        status: 201,
        response,
        location: this.location()
      };
    });
  }
};

// Returns nothing - doesn't wait for the trigger.
RestWrite.prototype.runAfterSaveTrigger = function () {
  if (!this.response || !this.response.response || this.runOptions.many) {
    return;
  }

  // Avoid doing any setup for triggers if there is no 'afterSave' trigger for this class.
  const hasAfterSaveHook = triggers.triggerExists(this.className, triggers.Types.afterSave, this.config.applicationId);
  const hasLiveQuery = this.config.liveQueryController.hasLiveQuery(this.className);
  if (!hasAfterSaveHook && !hasLiveQuery) {
    return Promise.resolve();
  }
  const {
    originalObject,
    updatedObject
  } = this.buildParseObjects();
  updatedObject._handleSaveResponse(this.response.response, this.response.status || 200);
  if (hasLiveQuery) {
    this.config.database.loadSchema().then(schemaController => {
      // Notify LiveQueryServer if possible
      const perms = schemaController.getClassLevelPermissions(updatedObject.className);
      this.config.liveQueryController.onAfterSave(updatedObject.className, updatedObject, originalObject, perms);
    });
  }
  if (!hasAfterSaveHook) {
    return Promise.resolve();
  }
  // Run afterSave trigger
  return triggers.maybeRunTrigger(triggers.Types.afterSave, this.auth, updatedObject, originalObject, this.config, this.context).then(result => {
    const jsonReturned = result && !result._toFullJSON;
    if (jsonReturned) {
      this.pendingOps.operations = {};
      this.response.response = result;
    } else {
      this.response.response = this._updateResponseWithData((result || updatedObject).toJSON(), this.data);
    }
  }).catch(function (err) {
    _logger.default.warn('afterSave caught an error', err);
  });
};

// A helper to figure out what location this operation happens at.
RestWrite.prototype.location = function () {
  var middle = this.className === '_User' ? '/users/' : '/classes/' + this.className + '/';
  const mount = this.config.mount || this.config.serverURL;
  return mount + middle + this.data.objectId;
};

// A helper to get the object id for this operation.
// Because it could be either on the query or on the data
RestWrite.prototype.objectId = function () {
  return this.data.objectId || this.query.objectId;
};

// Returns a copy of the data and delete bad keys (_auth_data, _hashed_password...)
RestWrite.prototype.sanitizedData = function () {
  const data = Object.keys(this.data).reduce((data, key) => {
    // Regexp comes from Parse.Object.prototype.validate
    if (!/^[A-Za-z][0-9A-Za-z_]*$/.test(key)) {
      delete data[key];
    }
    return data;
  }, structuredClone(this.data));
  return Parse._decode(undefined, data);
};

// Returns an updated copy of the object
RestWrite.prototype.buildParseObjects = function () {
  const extraData = {
    className: this.className,
    objectId: this.query?.objectId
  };
  let originalObject;
  if (this.query && this.query.objectId) {
    originalObject = triggers.inflate(extraData, this.originalData);
  }
  const className = Parse.Object.fromJSON(extraData);
  const readOnlyAttributes = className.constructor.readOnlyAttributes ? className.constructor.readOnlyAttributes() : [];

  // For _Role class, 'name' cannot be set after the role has an objectId.
  // In afterSave context, _handleSaveResponse has already set the objectId,
  // so we treat 'name' as read-only to avoid Parse SDK validation errors.
  const isRoleAfterSave = this.className === '_Role' && this.response && !this.query;
  if (isRoleAfterSave && this.data.name && !readOnlyAttributes.includes('name')) {
    readOnlyAttributes.push('name');
  }
  if (!this.originalData) {
    for (const attribute of readOnlyAttributes) {
      extraData[attribute] = this.data[attribute];
    }
  }
  const updatedObject = triggers.inflate(extraData, this.originalData);
  Object.keys(this.data).reduce(function (data, key) {
    if (key.indexOf('.') > 0) {
      if (typeof data[key].__op === 'string') {
        if (!readOnlyAttributes.includes(key)) {
          updatedObject.set(key, data[key]);
        }
      } else {
        // subdocument key with dot notation { 'x.y': v } => { 'x': { 'y' : v } })
        const splittedKey = key.split('.');
        const parentProp = splittedKey[0];
        let parentVal = updatedObject.get(parentProp);
        if (typeof parentVal !== 'object') {
          parentVal = {};
        }
        parentVal[splittedKey[1]] = data[key];
        updatedObject.set(parentProp, parentVal);
      }
      delete data[key];
    }
    return data;
  }, structuredClone(this.data));
  const sanitized = this.sanitizedData();
  for (const attribute of readOnlyAttributes) {
    delete sanitized[attribute];
  }
  updatedObject.set(sanitized);
  return {
    updatedObject,
    originalObject
  };
};
RestWrite.prototype.cleanUserAuthData = function () {
  if (this.response && this.response.response && this.className === '_User') {
    const user = this.response.response;
    if (user.authData) {
      Object.keys(user.authData).forEach(provider => {
        if (user.authData[provider] === null) {
          delete user.authData[provider];
        }
      });
      if (Object.keys(user.authData).length == 0) {
        delete user.authData;
      }
    }
  }
};

// Strips protected fields from the write response when protectedFieldsSaveResponseExempt is false.
RestWrite.prototype.filterProtectedFieldsInResponse = async function () {
  if (this.config.protectedFieldsSaveResponseExempt !== false) {
    return;
  }
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  if (!this.response || !this.response.response) {
    return;
  }
  const schemaController = await this.config.database.loadSchema();
  const protectedFields = this.config.database.addProtectedFields(schemaController, this.className, this.query ? {
    objectId: this.query.objectId
  } : {}, this.auth.user ? [this.auth.user.id].concat(this.auth.userRoles || []) : [], this.auth, {});
  if (!protectedFields) {
    return;
  }
  for (const field of protectedFields) {
    delete this.response.response[field];
  }
};
RestWrite.prototype._updateResponseWithData = function (response, data) {
  const stateController = Parse.CoreManager.getObjectStateController();
  const [pending] = stateController.getPendingOps(this.pendingOps.identifier);
  for (const key in this.pendingOps.operations) {
    if (!pending[key]) {
      data[key] = this.originalData ? this.originalData[key] : {
        __op: 'Delete'
      };
      this.storage.fieldsChangedByTrigger.push(key);
    }
  }
  const skipKeys = [...(_SchemaController.requiredColumns.read[this.className] || [])];
  if (!this.query) {
    skipKeys.push('objectId', 'createdAt');
  } else {
    skipKeys.push('updatedAt');
    delete response.objectId;
  }
  for (const key in response) {
    if (skipKeys.includes(key)) {
      continue;
    }
    const value = response[key];
    if (value == null || value.__type && value.__type === 'Pointer' || util.isDeepStrictEqual(data[key], value) || util.isDeepStrictEqual((this.originalData || {})[key], value)) {
      delete response[key];
    }
  }
  if (_lodash.default.isEmpty(this.storage.fieldsChangedByTrigger)) {
    return response;
  }
  const clientSupportsDelete = ClientSDK.supportsForwardDelete(this.clientSDK);
  this.storage.fieldsChangedByTrigger.forEach(fieldName => {
    const dataValue = data[fieldName];
    if (!Object.prototype.hasOwnProperty.call(response, fieldName)) {
      response[fieldName] = dataValue;
    }

    // Strips operations from responses
    if (response[fieldName] && response[fieldName].__op) {
      delete response[fieldName];
      if (clientSupportsDelete && dataValue.__op == 'Delete') {
        response[fieldName] = dataValue;
      }
    }
  });
  return response;
};
var _default = exports.default = RestWrite;
module.exports = RestWrite;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUmVzdFF1ZXJ5IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9TY2hlbWFDb250cm9sbGVyIiwiX0Vycm9yIiwiX0F1dGhEYXRhTG9jayIsIkluc3RhbGxhdGlvbkRlZHVwIiwiX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQiLCJlIiwidCIsIldlYWtNYXAiLCJyIiwibiIsIl9fZXNNb2R1bGUiLCJvIiwiaSIsImYiLCJfX3Byb3RvX18iLCJkZWZhdWx0IiwiaGFzIiwiZ2V0Iiwic2V0IiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiT2JqZWN0IiwiZGVmaW5lUHJvcGVydHkiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IiLCJTY2hlbWFDb250cm9sbGVyIiwiQXV0aCIsIlV0aWxzIiwiY3J5cHRvVXRpbHMiLCJwYXNzd29yZENyeXB0byIsIlBhcnNlIiwidHJpZ2dlcnMiLCJDbGllbnRTREsiLCJ1dGlsIiwiUmVzdFdyaXRlIiwiY29uZmlnIiwiYXV0aCIsImNsYXNzTmFtZSIsInF1ZXJ5IiwiZGF0YSIsIm9yaWdpbmFsRGF0YSIsImNsaWVudFNESyIsImNvbnRleHQiLCJhY3Rpb24iLCJpc1JlYWRPbmx5IiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJFcnJvciIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJzdG9yYWdlIiwicnVuT3B0aW9ucyIsImFsbG93Q3VzdG9tT2JqZWN0SWQiLCJwcm90b3R5cGUiLCJvYmplY3RJZCIsIk1JU1NJTkdfT0JKRUNUX0lEIiwiSU5WQUxJRF9LRVlfTkFNRSIsImlkIiwicmVzcG9uc2UiLCJzdHJ1Y3R1cmVkQ2xvbmUiLCJ1cGRhdGVkQXQiLCJfZW5jb2RlIiwiRGF0ZSIsImlzbyIsInZhbGlkU2NoZW1hQ29udHJvbGxlciIsInBlbmRpbmdPcHMiLCJvcGVyYXRpb25zIiwiaWRlbnRpZmllciIsImV4ZWN1dGUiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsImhhbmRsZUluc3RhbGxhdGlvbiIsImhhbmRsZVNlc3Npb24iLCJ2YWxpZGF0ZUF1dGhEYXRhIiwiY2hlY2tSZXN0cmljdGVkRmllbGRzIiwicnVuQmVmb3JlU2F2ZVRyaWdnZXIiLCJlbnN1cmVVbmlxdWVBdXRoRGF0YUlkIiwiZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQiLCJ2YWxpZGF0ZVNjaGVtYSIsInNjaGVtYUNvbnRyb2xsZXIiLCJzZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkIiwidmFsaWRhdGVDcmVhdGVQZXJtaXNzaW9uIiwidHJhbnNmb3JtVXNlciIsImV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzIiwiZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucyIsInJ1bkRhdGFiYXNlT3BlcmF0aW9uIiwiY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQiLCJoYW5kbGVGb2xsb3d1cCIsInJ1bkFmdGVyU2F2ZVRyaWdnZXIiLCJjbGVhblVzZXJBdXRoRGF0YSIsImZpbHRlclByb3RlY3RlZEZpZWxkc0luUmVzcG9uc2UiLCJhdXRoRGF0YVJlc3BvbnNlIiwicmVqZWN0U2lnbnVwIiwicHJldmVudFNpZ251cFdpdGhVbnZlcmlmaWVkRW1haWwiLCJFTUFJTF9OT1RfRk9VTkQiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJhY2wiLCJ1c2VyIiwiZ2V0VXNlclJvbGVzIiwicm9sZXMiLCJjb25jYXQiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwiaW5kZXhPZiIsImRhdGFiYXNlIiwibG9hZFNjaGVtYSIsImhhc0NsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJtYW55IiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYmVmb3JlU2F2ZSIsImFwcGxpY2F0aW9uSWQiLCJvcmlnaW5hbE9iamVjdCIsInVwZGF0ZWRPYmplY3QiLCJidWlsZFBhcnNlT2JqZWN0cyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJzdGF0ZUNvbnRyb2xsZXIiLCJDb3JlTWFuYWdlciIsImdldE9iamVjdFN0YXRlQ29udHJvbGxlciIsInBlbmRpbmciLCJnZXRQZW5kaW5nT3BzIiwiZGF0YWJhc2VQcm9taXNlIiwidXBkYXRlIiwiY3JlYXRlIiwicmVzdWx0IiwibGVuZ3RoIiwiT0JKRUNUX05PVF9GT1VORCIsIm1heWJlUnVuVHJpZ2dlciIsIm9iamVjdCIsImZpZWxkc0NoYW5nZWRCeVRyaWdnZXIiLCJfIiwicmVkdWNlIiwidmFsdWUiLCJrZXkiLCJpc0VxdWFsIiwicHVzaCIsImNoZWNrUHJvaGliaXRlZEtleXdvcmRzIiwiZXJyb3IiLCJydW5CZWZvcmVMb2dpblRyaWdnZXIiLCJ1c2VyRGF0YSIsImJlZm9yZUxvZ2luIiwiZXh0cmFEYXRhIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsImluZmxhdGUiLCJnZXRBbGxDbGFzc2VzIiwiYWxsQ2xhc3NlcyIsInNjaGVtYSIsImZpbmQiLCJvbmVDbGFzcyIsInNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCIsImZpZWxkTmFtZSIsInNldERlZmF1bHQiLCJ1bmRlZmluZWQiLCJfX29wIiwiZmllbGRzIiwiZGVmYXVsdFZhbHVlIiwicmVxdWlyZWQiLCJWQUxJREFUSU9OX0VSUk9SIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiQUNMIiwiSlNPTiIsInN0cmluZ2lmeSIsInJlYWQiLCJ3cml0ZSIsImN1cnJlbnRVc2VyIiwiY3JlYXRlZEF0IiwiX190eXBlIiwibmV3T2JqZWN0SWQiLCJvYmplY3RJZFNpemUiLCJrZXlzIiwiZm9yRWFjaCIsImF1dGhEYXRhIiwiaGFzVXNlcm5hbWVBbmRQYXNzd29yZCIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJoYXNBdXRoRGF0YSIsInNvbWUiLCJwcm92aWRlciIsInByb3ZpZGVyRGF0YSIsImlzRW1wdHkiLCJVU0VSTkFNRV9NSVNTSU5HIiwiUEFTU1dPUkRfTUlTU0lORyIsIlVOU1VQUE9SVEVEX1NFUlZJQ0UiLCJwcm92aWRlcnMiLCJjYW5IYW5kbGVBdXRoRGF0YSIsInByb3ZpZGVyQXV0aERhdGEiLCJnZXRVc2VySWQiLCJoYW5kbGVBdXRoRGF0YSIsImZpbHRlcmVkT2JqZWN0c0J5QUNMIiwib2JqZWN0cyIsImZpbHRlciIsIl90aHJvd0lmQXV0aERhdGFEdXBsaWNhdGUiLCJjb2RlIiwiRFVQTElDQVRFX1ZBTFVFIiwidXNlckluZm8iLCJkdXBsaWNhdGVkX2ZpZWxkIiwic3RhcnRzV2l0aCIsIkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQiLCJoYXNBdXRoRGF0YUlkIiwiZmluZFVzZXJzV2l0aEF1dGhEYXRhIiwicmVzdWx0cyIsInVzZXJJZCIsImN1cnJlbnRVc2VyQXV0aERhdGEiLCJ1c2VyUmVzdWx0IiwiZm91bmRVc2VySXNOb3RDdXJyZW50VXNlciIsImhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiIsInZhbGlkYXRlZEF1dGhEYXRhIiwiYXV0aFByb3ZpZGVyIiwiam9pbiIsImhhc011dGF0ZWRBdXRoRGF0YSIsIm11dGF0ZWRBdXRoRGF0YSIsImlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3RlciIsImlzTG9naW4iLCJsb2NhdGlvbiIsImNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4iLCJhbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuIiwicmVzIiwib3JpZ2luYWxBdXRoRGF0YSIsImZyb21FbnRyaWVzIiwiZW50cmllcyIsIm1hcCIsImsiLCJ2IiwiYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrIiwiU0NSSVBUX0ZBSUxFRCIsInZhbGlkYXRlUGVybWlzc2lvbiIsInByb21pc2UiLCJSZXN0UXVlcnkiLCJtZXRob2QiLCJNZXRob2QiLCJtYXN0ZXIiLCJydW5CZWZvcmVGaW5kIiwicmVzdFdoZXJlIiwic2Vzc2lvbiIsImNhY2hlQ29udHJvbGxlciIsImRlbCIsInNlc3Npb25Ub2tlbiIsIl92YWxpZGF0ZVBhc3N3b3JkUG9saWN5IiwiaGFzaCIsImhhc2hlZFBhc3N3b3JkIiwiX2hhc2hlZF9wYXNzd29yZCIsIl92YWxpZGF0ZVVzZXJOYW1lIiwiX3ZhbGlkYXRlRW1haWwiLCJyYW5kb21TdHJpbmciLCJyZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSIsIiRuZSIsImxpbWl0IiwiY2FzZUluc2Vuc2l0aXZlIiwiVVNFUk5BTUVfVEFLRU4iLCJidWlsZENyZWF0ZWRXaXRoIiwiZ2V0Q3JlYXRlZFdpdGgiLCJjcmVhdGVkV2l0aCIsImlzQ3JlYXRlT3BlcmF0aW9uIiwiYXV0aERhdGFQcm92aWRlciIsInJlc29sdmVkQXV0aFByb3ZpZGVyIiwiZW1haWwiLCJtYXRjaCIsInJlamVjdCIsIklOVkFMSURfRU1BSUxfQUREUkVTUyIsIkVNQUlMX1RBS0VOIiwicmVxdWVzdCIsIm9yaWdpbmFsIiwiaXAiLCJpbnN0YWxsYXRpb25JZCIsInVzZXJDb250cm9sbGVyIiwic2V0RW1haWxWZXJpZnlUb2tlbiIsInBhc3N3b3JkUG9saWN5IiwiX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMiLCJfdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkiLCJwb2xpY3lFcnJvciIsInZhbGlkYXRpb25FcnJvciIsImNvbnRhaW5zVXNlcm5hbWVFcnJvciIsInBhdHRlcm5WYWxpZGF0b3IiLCJ2YWxpZGF0b3JDYWxsYmFjayIsImRvTm90QWxsb3dVc2VybmFtZSIsIm1heFBhc3N3b3JkSGlzdG9yeSIsIm1haW50ZW5hbmNlIiwib2xkUGFzc3dvcmRzIiwiX3Bhc3N3b3JkX2hpc3RvcnkiLCJ0YWtlIiwibmV3UGFzc3dvcmQiLCJwcm9taXNlcyIsImNvbXBhcmUiLCJhbGwiLCJjYXRjaCIsImVyciIsInZlcmlmeVVzZXJFbWFpbHMiLCJwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsIiwiY3JlYXRlU2Vzc2lvblRva2VuIiwic2Vzc2lvbkRhdGEiLCJjcmVhdGVTZXNzaW9uIiwiYWRkaXRpb25hbFNlc3Npb25EYXRhIiwidG9rZW4iLCJuZXdUb2tlbiIsImV4cGlyZXNBdCIsImdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCIsImFzc2lnbiIsImFkZE9wcyIsIl9wZXJpc2hhYmxlX3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsImRlc3Ryb3kiLCJyZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0Iiwic2Vzc2lvblF1ZXJ5IiwiYmluZCIsInNlbmRWZXJpZmljYXRpb25FbWFpbCIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsIiRhbmQiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJzdGF0dXMiLCJkZXZpY2VUb2tlbiIsInRvTG93ZXJDYXNlIiwiZGV2aWNlVHlwZSIsImlkTWF0Y2giLCJvYmplY3RJZE1hdGNoIiwiaW5zdGFsbGF0aW9uSWRNYXRjaCIsImRldmljZVRva2VuTWF0Y2hlcyIsIm9yUXVlcmllcyIsIiRvciIsImRlbFF1ZXJ5IiwiYXBwSWRlbnRpZmllciIsImluc3RhbGxhdGlvbk9wdHMiLCJpbnN0YWxsYXRpb24iLCJyZW1vdmVDb25mbGljdGluZ0RldmljZVRva2VuIiwiZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24iLCJlbmZvcmNlQXV0aCIsImR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGgiLCJhcHBseUR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2UiLCJkZXZpY2VUb2tlbk1hdGNoIiwibWVyZ2VQcmlvcml0eSIsImR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2VQcmlvcml0eSIsIm9iaklkIiwidXNlcnMiLCJyb2xlIiwiY2xlYXIiLCJsaXZlUXVlcnlDb250cm9sbGVyIiwiY2xlYXJDYWNoZWRSb2xlcyIsImlzVW5hdXRoZW50aWNhdGVkIiwiU0VTU0lPTl9NSVNTSU5HIiwiZG93bmxvYWQiLCJkb3dubG9hZE5hbWUiLCJuYW1lIiwiSU5WQUxJRF9BQ0wiLCJtYXhQYXNzd29yZEFnZSIsIl9wYXNzd29yZF9jaGFuZ2VkX2F0IiwiZGVmZXIiLCJNYXRoIiwibWF4Iiwic2hpZnQiLCJfdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSIsImVuZm9yY2VQcml2YXRlVXNlcnMiLCJoYXNBZnRlclNhdmVIb29rIiwiYWZ0ZXJTYXZlIiwiaGFzTGl2ZVF1ZXJ5IiwiX2hhbmRsZVNhdmVSZXNwb25zZSIsInBlcm1zIiwiZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zIiwib25BZnRlclNhdmUiLCJqc29uUmV0dXJuZWQiLCJfdG9GdWxsSlNPTiIsInRvSlNPTiIsImxvZ2dlciIsIndhcm4iLCJtaWRkbGUiLCJtb3VudCIsInNlcnZlclVSTCIsInNhbml0aXplZERhdGEiLCJ0ZXN0IiwiX2RlY29kZSIsImZyb21KU09OIiwicmVhZE9ubHlBdHRyaWJ1dGVzIiwiY29uc3RydWN0b3IiLCJpc1JvbGVBZnRlclNhdmUiLCJpbmNsdWRlcyIsImF0dHJpYnV0ZSIsInNwbGl0dGVkS2V5Iiwic3BsaXQiLCJwYXJlbnRQcm9wIiwicGFyZW50VmFsIiwic2FuaXRpemVkIiwicHJvdGVjdGVkRmllbGRzU2F2ZVJlc3BvbnNlRXhlbXB0IiwicHJvdGVjdGVkRmllbGRzIiwiYWRkUHJvdGVjdGVkRmllbGRzIiwidXNlclJvbGVzIiwiZmllbGQiLCJza2lwS2V5cyIsInJlcXVpcmVkQ29sdW1ucyIsImlzRGVlcFN0cmljdEVxdWFsIiwiY2xpZW50U3VwcG9ydHNEZWxldGUiLCJzdXBwb3J0c0ZvcndhcmREZWxldGUiLCJkYXRhVmFsdWUiLCJfZGVmYXVsdCIsImV4cG9ydHMiLCJtb2R1bGUiXSwic291cmNlcyI6WyIuLi9zcmMvUmVzdFdyaXRlLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIEEgUmVzdFdyaXRlIGVuY2Fwc3VsYXRlcyBldmVyeXRoaW5nIHdlIG5lZWQgdG8gcnVuIGFuIG9wZXJhdGlvblxuLy8gdGhhdCB3cml0ZXMgdG8gdGhlIGRhdGFiYXNlLlxuLy8gVGhpcyBjb3VsZCBiZSBlaXRoZXIgYSBcImNyZWF0ZVwiIG9yIGFuIFwidXBkYXRlXCIuXG5cbnZhciBTY2hlbWFDb250cm9sbGVyID0gcmVxdWlyZSgnLi9Db250cm9sbGVycy9TY2hlbWFDb250cm9sbGVyJyk7XG5cbmNvbnN0IEF1dGggPSByZXF1aXJlKCcuL0F1dGgnKTtcbmNvbnN0IFV0aWxzID0gcmVxdWlyZSgnLi9VdGlscycpO1xudmFyIGNyeXB0b1V0aWxzID0gcmVxdWlyZSgnLi9jcnlwdG9VdGlscycpO1xudmFyIHBhc3N3b3JkQ3J5cHRvID0gcmVxdWlyZSgnLi9wYXNzd29yZCcpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpO1xudmFyIHRyaWdnZXJzID0gcmVxdWlyZSgnLi90cmlnZ2VycycpO1xudmFyIENsaWVudFNESyA9IHJlcXVpcmUoJy4vQ2xpZW50U0RLJyk7XG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuaW1wb3J0IFJlc3RRdWVyeSBmcm9tICcuL1Jlc3RRdWVyeSc7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IGxvZ2dlciBmcm9tICcuL2xvZ2dlcic7XG5pbXBvcnQgeyByZXF1aXJlZENvbHVtbnMgfSBmcm9tICcuL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXInO1xuaW1wb3J0IHsgY3JlYXRlU2FuaXRpemVkRXJyb3IgfSBmcm9tICcuL0Vycm9yJztcbmltcG9ydCB7IGFwcGx5QXV0aERhdGFPcHRpbWlzdGljTG9jayB9IGZyb20gJy4vQXV0aERhdGFMb2NrJztcbmltcG9ydCAqIGFzIEluc3RhbGxhdGlvbkRlZHVwIGZyb20gJy4vSW5zdGFsbGF0aW9uRGVkdXAnO1xuXG4vLyBxdWVyeSBhbmQgZGF0YSBhcmUgYm90aCBwcm92aWRlZCBpbiBSRVNUIEFQSSBmb3JtYXQuIFNvIGRhdGFcbi8vIHR5cGVzIGFyZSBlbmNvZGVkIGJ5IHBsYWluIG9sZCBvYmplY3RzLlxuLy8gSWYgcXVlcnkgaXMgbnVsbCwgdGhpcyBpcyBhIFwiY3JlYXRlXCIgYW5kIHRoZSBkYXRhIGluIGRhdGEgc2hvdWxkIGJlXG4vLyBjcmVhdGVkLlxuLy8gT3RoZXJ3aXNlIHRoaXMgaXMgYW4gXCJ1cGRhdGVcIiAtIHRoZSBvYmplY3QgbWF0Y2hpbmcgdGhlIHF1ZXJ5XG4vLyBzaG91bGQgZ2V0IHVwZGF0ZWQgd2l0aCBkYXRhLlxuLy8gUmVzdFdyaXRlIHdpbGwgaGFuZGxlIG9iamVjdElkLCBjcmVhdGVkQXQsIGFuZCB1cGRhdGVkQXQgZm9yXG4vLyBldmVyeXRoaW5nLiBJdCBhbHNvIGtub3dzIHRvIHVzZSB0cmlnZ2VycyBhbmQgc3BlY2lhbCBtb2RpZmljYXRpb25zXG4vLyBmb3IgdGhlIF9Vc2VyIGNsYXNzLlxuZnVuY3Rpb24gUmVzdFdyaXRlKGNvbmZpZywgYXV0aCwgY2xhc3NOYW1lLCBxdWVyeSwgZGF0YSwgb3JpZ2luYWxEYXRhLCBjbGllbnRTREssIGNvbnRleHQsIGFjdGlvbikge1xuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgJ0Nhbm5vdCBwZXJmb3JtIGEgd3JpdGUgb3BlcmF0aW9uIHdoZW4gdXNpbmcgcmVhZE9ubHlNYXN0ZXJLZXknLFxuICAgICAgY29uZmlnXG4gICAgKTtcbiAgfVxuICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgdGhpcy5hdXRoID0gYXV0aDtcbiAgdGhpcy5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gIHRoaXMuY2xpZW50U0RLID0gY2xpZW50U0RLO1xuICB0aGlzLnN0b3JhZ2UgPSB7fTtcbiAgdGhpcy5ydW5PcHRpb25zID0ge307XG4gIHRoaXMuY29udGV4dCA9IGNvbnRleHQgfHwge307XG5cbiAgaWYgKGFjdGlvbikge1xuICAgIHRoaXMucnVuT3B0aW9ucy5hY3Rpb24gPSBhY3Rpb247XG4gIH1cblxuICBpZiAoIXF1ZXJ5KSB7XG4gICAgaWYgKHRoaXMuY29uZmlnLmFsbG93Q3VzdG9tT2JqZWN0SWQpIHtcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoZGF0YSwgJ29iamVjdElkJykgJiYgIWRhdGEub2JqZWN0SWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLk1JU1NJTkdfT0JKRUNUX0lELFxuICAgICAgICAgICdvYmplY3RJZCBtdXN0IG5vdCBiZSBlbXB0eSwgbnVsbCBvciB1bmRlZmluZWQnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChkYXRhLm9iamVjdElkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnb2JqZWN0SWQgaXMgYW4gaW52YWxpZCBmaWVsZCBuYW1lLicpO1xuICAgICAgfVxuICAgICAgaWYgKGRhdGEuaWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdpZCBpcyBhbiBpbnZhbGlkIGZpZWxkIG5hbWUuJyk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gV2hlbiB0aGUgb3BlcmF0aW9uIGlzIGNvbXBsZXRlLCB0aGlzLnJlc3BvbnNlIG1heSBoYXZlIHNldmVyYWxcbiAgLy8gZmllbGRzLlxuICAvLyByZXNwb25zZTogdGhlIGFjdHVhbCBkYXRhIHRvIGJlIHJldHVybmVkXG4gIC8vIHN0YXR1czogdGhlIGh0dHAgc3RhdHVzIGNvZGUuIGlmIG5vdCBwcmVzZW50LCB0cmVhdGVkIGxpa2UgYSAyMDBcbiAgLy8gbG9jYXRpb246IHRoZSBsb2NhdGlvbiBoZWFkZXIuIGlmIG5vdCBwcmVzZW50LCBubyBsb2NhdGlvbiBoZWFkZXJcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG5cbiAgLy8gUHJvY2Vzc2luZyB0aGlzIG9wZXJhdGlvbiBtYXkgbXV0YXRlIG91ciBkYXRhLCBzbyB3ZSBvcGVyYXRlIG9uIGFcbiAgLy8gY29weVxuICB0aGlzLnF1ZXJ5ID0gc3RydWN0dXJlZENsb25lKHF1ZXJ5KTtcbiAgdGhpcy5kYXRhID0gc3RydWN0dXJlZENsb25lKGRhdGEpO1xuICAvLyBXZSBuZXZlciBjaGFuZ2Ugb3JpZ2luYWxEYXRhLCBzbyB3ZSBkbyBub3QgbmVlZCBhIGRlZXAgY29weVxuICB0aGlzLm9yaWdpbmFsRGF0YSA9IG9yaWdpbmFsRGF0YTtcblxuICAvLyBUaGUgdGltZXN0YW1wIHdlJ2xsIHVzZSBmb3IgdGhpcyB3aG9sZSBvcGVyYXRpb25cbiAgdGhpcy51cGRhdGVkQXQgPSBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKCkpLmlzbztcblxuICAvLyBTaGFyZWQgU2NoZW1hQ29udHJvbGxlciB0byBiZSByZXVzZWQgdG8gcmVkdWNlIHRoZSBudW1iZXIgb2YgbG9hZFNjaGVtYSgpIGNhbGxzIHBlciByZXF1ZXN0XG4gIC8vIE9uY2Ugc2V0IHRoZSBzY2hlbWFEYXRhIHNob3VsZCBiZSBpbW11dGFibGVcbiAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIgPSBudWxsO1xuICB0aGlzLnBlbmRpbmdPcHMgPSB7XG4gICAgb3BlcmF0aW9uczogbnVsbCxcbiAgICBpZGVudGlmaWVyOiBudWxsLFxuICB9O1xufVxuXG4vLyBBIGNvbnZlbmllbnQgbWV0aG9kIHRvIHBlcmZvcm0gYWxsIHRoZSBzdGVwcyBvZiBwcm9jZXNzaW5nIHRoZVxuLy8gd3JpdGUsIGluIG9yZGVyLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIGEge3Jlc3BvbnNlLCBzdGF0dXMsIGxvY2F0aW9ufSBvYmplY3QuXG4vLyBzdGF0dXMgYW5kIGxvY2F0aW9uIGFyZSBvcHRpb25hbC5cblJlc3RXcml0ZS5wcm90b3R5cGUuZXhlY3V0ZSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZ2V0VXNlckFuZFJvbGVBQ0woKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlSW5zdGFsbGF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVTZXNzaW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUF1dGhEYXRhKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jaGVja1Jlc3RyaWN0ZWRGaWVsZHMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkJlZm9yZVNhdmVUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5lbnN1cmVVbmlxdWVBdXRoRGF0YUlkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5kZWxldGVFbWFpbFJlc2V0VG9rZW5JZk5lZWRlZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVTY2hlbWEoKTtcbiAgICB9KVxuICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIgPSBzY2hlbWFDb250cm9sbGVyO1xuICAgICAgcmV0dXJuIHRoaXMuc2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVDcmVhdGVQZXJtaXNzaW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy50cmFuc2Zvcm1Vc2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5leHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cygpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucygpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuRGF0YWJhc2VPcGVyYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVGb2xsb3d1cCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuQWZ0ZXJTYXZlVHJpZ2dlcigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY2xlYW5Vc2VyQXV0aERhdGEoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmZpbHRlclByb3RlY3RlZEZpZWxkc0luUmVzcG9uc2UoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIEFwcGVuZCB0aGUgYXV0aERhdGFSZXNwb25zZSBpZiBleGlzdHNcbiAgICAgIGlmICh0aGlzLmF1dGhEYXRhUmVzcG9uc2UpIHtcbiAgICAgICAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UuYXV0aERhdGFSZXNwb25zZSA9IHRoaXMuYXV0aERhdGFSZXNwb25zZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHRoaXMuc3RvcmFnZS5yZWplY3RTaWdudXAgJiYgdGhpcy5jb25maWcucHJldmVudFNpZ251cFdpdGhVbnZlcmlmaWVkRW1haWwpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX05PVF9GT1VORCwgJ1VzZXIgZW1haWwgaXMgbm90IHZlcmlmaWVkLicpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRoaXMucmVzcG9uc2U7XG4gICAgfSk7XG59O1xuXG4vLyBVc2VzIHRoZSBBdXRoIG9iamVjdCB0byBnZXQgdGhlIGxpc3Qgb2Ygcm9sZXMsIGFkZHMgdGhlIHVzZXIgaWRcblJlc3RXcml0ZS5wcm90b3R5cGUuZ2V0VXNlckFuZFJvbGVBQ0wgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIgfHwgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB0aGlzLnJ1bk9wdGlvbnMuYWNsID0gWycqJ107XG5cbiAgaWYgKHRoaXMuYXV0aC51c2VyKSB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC5nZXRVc2VyUm9sZXMoKS50aGVuKHJvbGVzID0+IHtcbiAgICAgIHRoaXMucnVuT3B0aW9ucy5hY2wgPSB0aGlzLnJ1bk9wdGlvbnMuYWNsLmNvbmNhdChyb2xlcywgW3RoaXMuYXV0aC51c2VyLmlkXSk7XG4gICAgICByZXR1cm47XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIGNvbmZpZy5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAoXG4gICAgdGhpcy5jb25maWcuYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uID09PSBmYWxzZSAmJlxuICAgICF0aGlzLmF1dGguaXNNYXN0ZXIgJiZcbiAgICAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UgJiZcbiAgICBTY2hlbWFDb250cm9sbGVyLnN5c3RlbUNsYXNzZXMuaW5kZXhPZih0aGlzLmNsYXNzTmFtZSkgPT09IC0xXG4gICkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmhhc0NsYXNzKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAgIC50aGVuKGhhc0NsYXNzID0+IHtcbiAgICAgICAgaWYgKGhhc0NsYXNzICE9PSB0cnVlKSB7XG4gICAgICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgJ1RoaXMgdXNlciBpcyBub3QgYWxsb3dlZCB0byBhY2Nlc3Mgbm9uLWV4aXN0ZW50IGNsYXNzOiAnICsgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICB0aGlzLmNvbmZpZ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIHNjaGVtYS5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVTY2hlbWEgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS52YWxpZGF0ZU9iamVjdChcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0aGlzLmRhdGEsXG4gICAgdGhpcy5xdWVyeSxcbiAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2VcbiAgKTtcbn07XG5cbi8vIFJ1bnMgYW55IGJlZm9yZVNhdmUgdHJpZ2dlcnMgYWdhaW5zdCB0aGlzIG9wZXJhdGlvbi5cbi8vIEFueSBjaGFuZ2UgbGVhZHMgdG8gb3VyIGRhdGEgYmVpbmcgbXV0YXRlZC5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQmVmb3JlU2F2ZVRyaWdnZXIgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMucnVuT3B0aW9ucy5tYW55KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYmVmb3JlU2F2ZScgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgaWYgKFxuICAgICF0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKHRoaXMuY2xhc3NOYW1lLCB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLCB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkKVxuICApIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjb25zdCB7IG9yaWdpbmFsT2JqZWN0LCB1cGRhdGVkT2JqZWN0IH0gPSB0aGlzLmJ1aWxkUGFyc2VPYmplY3RzKCk7XG4gIGNvbnN0IGlkZW50aWZpZXIgPSB1cGRhdGVkT2JqZWN0Ll9nZXRTdGF0ZUlkZW50aWZpZXIoKTtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKGlkZW50aWZpZXIpO1xuICB0aGlzLnBlbmRpbmdPcHMgPSB7XG4gICAgb3BlcmF0aW9uczogeyAuLi5wZW5kaW5nIH0sXG4gICAgaWRlbnRpZmllcixcbiAgfTtcblxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICAvLyBCZWZvcmUgY2FsbGluZyB0aGUgdHJpZ2dlciwgdmFsaWRhdGUgdGhlIHBlcm1pc3Npb25zIGZvciB0aGUgc2F2ZSBvcGVyYXRpb25cbiAgICAgIGxldCBkYXRhYmFzZVByb21pc2UgPSBudWxsO1xuICAgICAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICAgICAgLy8gVmFsaWRhdGUgZm9yIHVwZGF0aW5nXG4gICAgICAgIGRhdGFiYXNlUHJvbWlzZSA9IHRoaXMuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZShcbiAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICB0aGlzLnF1ZXJ5LFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgY3JlYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UuY3JlYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgdHJ1ZVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gSW4gdGhlIGNhc2UgdGhhdCB0aGVyZSBpcyBubyBwZXJtaXNzaW9uIGZvciB0aGUgb3BlcmF0aW9uLCBpdCB0aHJvd3MgYW4gZXJyb3JcbiAgICAgIHJldHVybiBkYXRhYmFzZVByb21pc2UudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICBpZiAoIXJlc3VsdCB8fCByZXN1bHQubGVuZ3RoIDw9IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQuJyk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyaWdnZXJzLm1heWJlUnVuVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgICAgdGhpcy5hdXRoLFxuICAgICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgdGhpcy5jb25maWcsXG4gICAgICAgIHRoaXMuY29udGV4dFxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSBfLnJlZHVjZShcbiAgICAgICAgICByZXNwb25zZS5vYmplY3QsXG4gICAgICAgICAgKHJlc3VsdCwgdmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRXF1YWwodGhpcy5kYXRhW2tleV0sIHZhbHVlKSkge1xuICAgICAgICAgICAgICByZXN1bHQucHVzaChrZXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICB9LFxuICAgICAgICAgIFtdXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGF0YSA9IHJlc3BvbnNlLm9iamVjdDtcbiAgICAgICAgLy8gV2Ugc2hvdWxkIGRlbGV0ZSB0aGUgb2JqZWN0SWQgZm9yIGFuIHVwZGF0ZSB3cml0ZVxuICAgICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgVXRpbHMuY2hlY2tQcm9oaWJpdGVkS2V5d29yZHModGhpcy5jb25maWcsIHRoaXMuZGF0YSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgYCR7ZXJyb3J9YCk7XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlciA9IGFzeW5jIGZ1bmN0aW9uICh1c2VyRGF0YSkge1xuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdiZWZvcmVMb2dpbicgdHJpZ2dlclxuICBpZiAoXG4gICAgIXRyaWdnZXJzLnRyaWdnZXJFeGlzdHModGhpcy5jbGFzc05hbWUsIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUxvZ2luLCB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkKVxuICApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBDbG91ZCBjb2RlIGdldHMgYSBiaXQgb2YgZXh0cmEgZGF0YSBmb3IgaXRzIG9iamVjdHNcbiAgY29uc3QgZXh0cmFEYXRhID0geyBjbGFzc05hbWU6IHRoaXMuY2xhc3NOYW1lIH07XG5cbiAgLy8gRXhwYW5kIGZpbGUgb2JqZWN0c1xuICBhd2FpdCB0aGlzLmNvbmZpZy5maWxlc0NvbnRyb2xsZXIuZXhwYW5kRmlsZXNJbk9iamVjdCh0aGlzLmNvbmZpZywgdXNlckRhdGEpO1xuXG4gIGNvbnN0IHVzZXIgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdXNlckRhdGEpO1xuXG4gIC8vIG5vIG5lZWQgdG8gcmV0dXJuIGEgcmVzcG9uc2VcbiAgYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKFxuICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUxvZ2luLFxuICAgIHRoaXMuYXV0aCxcbiAgICB1c2VyLFxuICAgIG51bGwsXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5jb250ZXh0XG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnNldFJlcXVpcmVkRmllbGRzSWZOZWVkZWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmRhdGEpIHtcbiAgICByZXR1cm4gdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIuZ2V0QWxsQ2xhc3NlcygpLnRoZW4oYWxsQ2xhc3NlcyA9PiB7XG4gICAgICBjb25zdCBzY2hlbWEgPSBhbGxDbGFzc2VzLmZpbmQob25lQ2xhc3MgPT4gb25lQ2xhc3MuY2xhc3NOYW1lID09PSB0aGlzLmNsYXNzTmFtZSk7XG4gICAgICBjb25zdCBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQgPSAoZmllbGROYW1lLCBzZXREZWZhdWx0KSA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkIHx8XG4gICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IG51bGwgfHxcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gJycgfHxcbiAgICAgICAgICAodHlwZW9mIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnb2JqZWN0JyAmJiB0aGlzLmRhdGFbZmllbGROYW1lXS5fX29wID09PSAnRGVsZXRlJylcbiAgICAgICAgKSB7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgc2V0RGVmYXVsdCAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlICE9PSBudWxsICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgICAgICh0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkIHx8XG4gICAgICAgICAgICAgICh0eXBlb2YgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09ICdvYmplY3QnICYmIHRoaXMuZGF0YVtmaWVsZE5hbWVdLl9fb3AgPT09ICdEZWxldGUnKSlcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID0gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZTtcbiAgICAgICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyID0gdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgfHwgW107XG4gICAgICAgICAgICBpZiAodGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuaW5kZXhPZihmaWVsZE5hbWUpIDwgMCkge1xuICAgICAgICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJlcXVpcmVkID09PSB0cnVlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUiwgYCR7ZmllbGROYW1lfSBpcyByZXF1aXJlZGApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgLy8gYWRkIGRlZmF1bHQgQUNMIChvbmx5IG9uIENSRUFURSwgbm90IFVQREFURSlcbiAgICAgIGlmICghdGhpcy5xdWVyeSAmJlxuICAgICAgICBzY2hlbWE/LmNsYXNzTGV2ZWxQZXJtaXNzaW9ucz8uQUNMICYmXG4gICAgICAgICF0aGlzLmRhdGEuQUNMICYmXG4gICAgICAgIEpTT04uc3RyaW5naWZ5KHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMuQUNMKSAhPT1cbiAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7ICcqJzogeyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9IH0pXG4gICAgICApIHtcbiAgICAgICAgY29uc3QgYWNsID0gc3RydWN0dXJlZENsb25lKHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMuQUNMKTtcbiAgICAgICAgaWYgKGFjbC5jdXJyZW50VXNlcikge1xuICAgICAgICAgIGlmICh0aGlzLmF1dGgudXNlcj8uaWQpIHtcbiAgICAgICAgICAgIGFjbFt0aGlzLmF1dGgudXNlcj8uaWRdID0gc3RydWN0dXJlZENsb25lKGFjbC5jdXJyZW50VXNlcik7XG4gICAgICAgICAgfVxuICAgICAgICAgIGRlbGV0ZSBhY2wuY3VycmVudFVzZXI7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5kYXRhLkFDTCA9IGFjbDtcbiAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciB8fCBbXTtcbiAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIucHVzaCgnQUNMJyk7XG4gICAgICB9XG5cbiAgICAgIC8vIEFkZCBkZWZhdWx0IGZpZWxkc1xuICAgICAgaWYgKCF0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIC8vIGFsbG93IGN1c3RvbWl6aW5nIGNyZWF0ZWRBdCBhbmQgdXBkYXRlZEF0IHdoZW4gdXNpbmcgbWFpbnRlbmFuY2Uga2V5XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0Ll9fdHlwZSA9PT0gJ0RhdGUnXG4gICAgICAgICkge1xuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0LmlzbztcblxuICAgICAgICAgIGlmICh0aGlzLmRhdGEudXBkYXRlZEF0ICYmIHRoaXMuZGF0YS51cGRhdGVkQXQuX190eXBlID09PSAnRGF0ZScpIHtcbiAgICAgICAgICAgIGNvbnN0IGNyZWF0ZWRBdCA9IG5ldyBEYXRlKHRoaXMuZGF0YS5jcmVhdGVkQXQpO1xuICAgICAgICAgICAgY29uc3QgdXBkYXRlZEF0ID0gbmV3IERhdGUodGhpcy5kYXRhLnVwZGF0ZWRBdC5pc28pO1xuXG4gICAgICAgICAgICBpZiAodXBkYXRlZEF0IDwgY3JlYXRlZEF0KSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgICd1cGRhdGVkQXQgY2Fubm90IG9jY3VyIGJlZm9yZSBjcmVhdGVkQXQnXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLmRhdGEudXBkYXRlZEF0LmlzbztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gaWYgbm8gdXBkYXRlZEF0IGlzIHByb3ZpZGVkLCBzZXQgaXQgdG8gY3JlYXRlZEF0IHRvIG1hdGNoIGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gT25seSBhc3NpZ24gbmV3IG9iamVjdElkIGlmIHdlIGFyZSBjcmVhdGluZyBuZXcgb2JqZWN0XG4gICAgICAgIGlmICghdGhpcy5kYXRhLm9iamVjdElkKSB7XG4gICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gY3J5cHRvVXRpbHMubmV3T2JqZWN0SWQodGhpcy5jb25maWcub2JqZWN0SWRTaXplKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2NoZW1hKSB7XG4gICAgICAgICAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgc2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkKGZpZWxkTmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcblxuICAgICAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQoZmllbGROYW1lLCBmYWxzZSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cbi8vIFRyYW5zZm9ybXMgYXV0aCBkYXRhIGZvciBhIHVzZXIgb2JqZWN0LlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYSB1c2VyIG9iamVjdC5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVBdXRoRGF0YSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYXV0aERhdGEgPSB0aGlzLmRhdGEuYXV0aERhdGE7XG4gIGNvbnN0IGhhc1VzZXJuYW1lQW5kUGFzc3dvcmQgPVxuICAgIHR5cGVvZiB0aGlzLmRhdGEudXNlcm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiB0aGlzLmRhdGEucGFzc3dvcmQgPT09ICdzdHJpbmcnO1xuICBjb25zdCBoYXNBdXRoRGF0YSA9XG4gICAgYXV0aERhdGEgJiZcbiAgICBPYmplY3Qua2V5cyhhdXRoRGF0YSkuc29tZShwcm92aWRlciA9PiB7XG4gICAgICBjb25zdCBwcm92aWRlckRhdGEgPSBhdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICByZXR1cm4gcHJvdmlkZXJEYXRhICYmIHR5cGVvZiBwcm92aWRlckRhdGEgPT09ICdvYmplY3QnICYmIE9iamVjdC5rZXlzKHByb3ZpZGVyRGF0YSkubGVuZ3RoO1xuICAgIH0pO1xuXG4gIGlmICghdGhpcy5xdWVyeSAmJiAhaGFzQXV0aERhdGEpIHtcbiAgICBpZiAodHlwZW9mIHRoaXMuZGF0YS51c2VybmFtZSAhPT0gJ3N0cmluZycgfHwgXy5pc0VtcHR5KHRoaXMuZGF0YS51c2VybmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5VU0VSTkFNRV9NSVNTSU5HLCAnYmFkIG9yIG1pc3NpbmcgdXNlcm5hbWUnKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB0aGlzLmRhdGEucGFzc3dvcmQgIT09ICdzdHJpbmcnIHx8IF8uaXNFbXB0eSh0aGlzLmRhdGEucGFzc3dvcmQpKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuUEFTU1dPUkRfTUlTU0lORywgJ3Bhc3N3b3JkIGlzIHJlcXVpcmVkJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwodGhpcy5kYXRhLCAnYXV0aERhdGEnKSkge1xuICAgIC8vIE5vdGhpbmcgdG8gdmFsaWRhdGUgaGVyZVxuICAgIHJldHVybjtcbiAgfSBlbHNlIGlmICghdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgLy8gSGFuZGxlIHNhdmluZyBhdXRoRGF0YSB0byBudWxsXG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuVU5TVVBQT1JURURfU0VSVklDRSxcbiAgICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICAgKTtcbiAgfVxuXG4gIHZhciBwcm92aWRlcnMgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSk7XG4gIGlmICghcHJvdmlkZXJzLmxlbmd0aCkge1xuICAgIC8vIEVtcHR5IGF1dGhEYXRhIG9iamVjdCwgbm90aGluZyB0byB2YWxpZGF0ZVxuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBjYW5IYW5kbGVBdXRoRGF0YSA9IHByb3ZpZGVycy5zb21lKHByb3ZpZGVyID0+IHtcbiAgICBjb25zdCBwcm92aWRlckF1dGhEYXRhID0gYXV0aERhdGFbcHJvdmlkZXJdIHx8IHt9O1xuICAgIHJldHVybiAhIU9iamVjdC5rZXlzKHByb3ZpZGVyQXV0aERhdGEpLmxlbmd0aDtcbiAgfSk7XG4gIGlmIChjYW5IYW5kbGVBdXRoRGF0YSB8fCBoYXNVc2VybmFtZUFuZFBhc3N3b3JkIHx8IHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmdldFVzZXJJZCgpKSB7XG4gICAgcmV0dXJuIHRoaXMuaGFuZGxlQXV0aERhdGEoYXV0aERhdGEpO1xuICB9XG4gIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbHRlcmVkT2JqZWN0c0J5QUNMID0gZnVuY3Rpb24gKG9iamVjdHMpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybiBvYmplY3RzO1xuICB9XG4gIHJldHVybiBvYmplY3RzLmZpbHRlcihvYmplY3QgPT4ge1xuICAgIGlmICghb2JqZWN0LkFDTCkge1xuICAgICAgcmV0dXJuIHRydWU7IC8vIGxlZ2FjeSB1c2VycyB0aGF0IGhhdmUgbm8gQUNMIGZpZWxkIG9uIHRoZW1cbiAgICB9XG4gICAgLy8gUmVndWxhciB1c2VycyB0aGF0IGhhdmUgYmVlbiBsb2NrZWQgb3V0LlxuICAgIHJldHVybiBvYmplY3QuQUNMICYmIE9iamVjdC5rZXlzKG9iamVjdC5BQ0wpLmxlbmd0aCA+IDA7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VySWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gdGhpcy5xdWVyeS5vYmplY3RJZDtcbiAgfSBlbHNlIGlmICh0aGlzLmF1dGggJiYgdGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLnVzZXIuaWQ7XG4gIH1cbn07XG5cbi8vIERldmVsb3BlcnMgYXJlIGFsbG93ZWQgdG8gY2hhbmdlIGF1dGhEYXRhIHZpYSBiZWZvcmUgc2F2ZSB0cmlnZ2VyXG5SZXN0V3JpdGUucHJvdG90eXBlLl90aHJvd0lmQXV0aERhdGFEdXBsaWNhdGUgPSBmdW5jdGlvbiAoZXJyb3IpIHtcbiAgaWYgKFxuICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgZXJyb3I/LmNvZGUgPT09IFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSAmJlxuICAgIGVycm9yLnVzZXJJbmZvPy5kdXBsaWNhdGVkX2ZpZWxkPy5zdGFydHNXaXRoKCdfYXV0aF9kYXRhXycpXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG59O1xuXG4vLyB3ZSBuZWVkIGFmdGVyIGJlZm9yZSBzYXZlIHRvIGVuc3VyZSB0aGF0IHRoZSBkZXZlbG9wZXJcbi8vIGlzIG5vdCBjdXJyZW50bHkgZHVwbGljYXRpbmcgYXV0aCBkYXRhIElEXG5SZXN0V3JpdGUucHJvdG90eXBlLmVuc3VyZVVuaXF1ZUF1dGhEYXRhSWQgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaGFzQXV0aERhdGFJZCA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkuc29tZShcbiAgICBrZXkgPT4gdGhpcy5kYXRhLmF1dGhEYXRhW2tleV0gJiYgdGhpcy5kYXRhLmF1dGhEYXRhW2tleV0uaWRcbiAgKTtcblxuICBpZiAoIWhhc0F1dGhEYXRhSWQpIHsgcmV0dXJuOyB9XG5cbiAgY29uc3QgciA9IGF3YWl0IEF1dGguZmluZFVzZXJzV2l0aEF1dGhEYXRhKHRoaXMuY29uZmlnLCB0aGlzLmRhdGEuYXV0aERhdGEpO1xuICBjb25zdCByZXN1bHRzID0gdGhpcy5maWx0ZXJlZE9iamVjdHNCeUFDTChyKTtcbiAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG4gIC8vIHVzZSBkYXRhLm9iamVjdElkIGluIGNhc2Ugb2YgbG9naW4gdGltZSBhbmQgZm91bmQgdXNlciBkdXJpbmcgaGFuZGxlIHZhbGlkYXRlQXV0aERhdGFcbiAgY29uc3QgdXNlcklkID0gdGhpcy5nZXRVc2VySWQoKSB8fCB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gIGlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMSAmJiB1c2VySWQgIT09IHJlc3VsdHNbMF0ub2JqZWN0SWQpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuQUNDT1VOVF9BTFJFQURZX0xJTktFRCwgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVBdXRoRGF0YSA9IGFzeW5jIGZ1bmN0aW9uIChhdXRoRGF0YSkge1xuICBsZXQgY3VycmVudFVzZXJBdXRoRGF0YTtcbiAgaWYgKHRoaXMucXVlcnk/Lm9iamVjdElkKSB7XG4gICAgY29uc3QgW2N1cnJlbnRVc2VyXSA9IGF3YWl0IHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAnX1VzZXInLFxuICAgICAgeyBvYmplY3RJZDogdGhpcy5xdWVyeS5vYmplY3RJZCB9XG4gICAgKTtcbiAgICBjdXJyZW50VXNlckF1dGhEYXRhID0gY3VycmVudFVzZXI/LmF1dGhEYXRhO1xuICB9XG4gIGNvbnN0IHIgPSBhd2FpdCBBdXRoLmZpbmRVc2Vyc1dpdGhBdXRoRGF0YSh0aGlzLmNvbmZpZywgYXV0aERhdGEsIHRydWUsIGN1cnJlbnRVc2VyQXV0aERhdGEpO1xuICBjb25zdCByZXN1bHRzID0gdGhpcy5maWx0ZXJlZE9iamVjdHNCeUFDTChyKTtcblxuICBjb25zdCB1c2VySWQgPSB0aGlzLmdldFVzZXJJZCgpO1xuICBjb25zdCB1c2VyUmVzdWx0ID0gcmVzdWx0c1swXTtcbiAgY29uc3QgZm91bmRVc2VySXNOb3RDdXJyZW50VXNlciA9IHVzZXJJZCAmJiB1c2VyUmVzdWx0ICYmIHVzZXJJZCAhPT0gdXNlclJlc3VsdC5vYmplY3RJZDtcblxuICBpZiAocmVzdWx0cy5sZW5ndGggPiAxIHx8IGZvdW5kVXNlcklzTm90Q3VycmVudFVzZXIpIHtcbiAgICAvLyBUbyBhdm9pZCBodHRwczovL2dpdGh1Yi5jb20vcGFyc2UtY29tbXVuaXR5L3BhcnNlLXNlcnZlci9zZWN1cml0eS9hZHZpc29yaWVzL0dIU0EtOHczai1nOTgzLThqaDVcbiAgICAvLyBMZXQncyBydW4gc29tZSB2YWxpZGF0aW9uIGJlZm9yZSB0aHJvd2luZ1xuICAgIGF3YWl0IEF1dGguaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKGF1dGhEYXRhLCB0aGlzLCB1c2VyUmVzdWx0KTtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuQUNDT1VOVF9BTFJFQURZX0xJTktFRCwgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnKTtcbiAgfVxuXG4gIC8vIE5vIHVzZXIgZm91bmQgd2l0aCBwcm92aWRlZCBhdXRoRGF0YSB3ZSBuZWVkIHRvIHZhbGlkYXRlXG4gIGlmICghcmVzdWx0cy5sZW5ndGgpIHtcbiAgICBjb25zdCB7IGF1dGhEYXRhOiB2YWxpZGF0ZWRBdXRoRGF0YSwgYXV0aERhdGFSZXNwb25zZSB9ID0gYXdhaXQgQXV0aC5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24oXG4gICAgICBhdXRoRGF0YSxcbiAgICAgIHRoaXNcbiAgICApO1xuICAgIHRoaXMuYXV0aERhdGFSZXNwb25zZSA9IGF1dGhEYXRhUmVzcG9uc2U7XG4gICAgLy8gUmVwbGFjZSBjdXJyZW50IGF1dGhEYXRhIGJ5IHRoZSBuZXcgdmFsaWRhdGVkIG9uZVxuICAgIHRoaXMuZGF0YS5hdXRoRGF0YSA9IHZhbGlkYXRlZEF1dGhEYXRhO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFVzZXIgZm91bmQgd2l0aCBwcm92aWRlZCBhdXRoRGF0YVxuICBpZiAocmVzdWx0cy5sZW5ndGggPT09IDEpIHtcbiAgICB0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyID0gT2JqZWN0LmtleXMoYXV0aERhdGEpLmpvaW4oJywnKTtcblxuICAgIGNvbnN0IHsgaGFzTXV0YXRlZEF1dGhEYXRhLCBtdXRhdGVkQXV0aERhdGEgfSA9IEF1dGguaGFzTXV0YXRlZEF1dGhEYXRhKFxuICAgICAgYXV0aERhdGEsXG4gICAgICB1c2VyUmVzdWx0LmF1dGhEYXRhXG4gICAgKTtcblxuICAgIGNvbnN0IGlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3RlciA9XG4gICAgICAodGhpcy5hdXRoICYmIHRoaXMuYXV0aC51c2VyICYmIHRoaXMuYXV0aC51c2VyLmlkID09PSB1c2VyUmVzdWx0Lm9iamVjdElkKSB8fFxuICAgICAgdGhpcy5hdXRoLmlzTWFzdGVyO1xuXG4gICAgY29uc3QgaXNMb2dpbiA9ICF1c2VySWQ7XG5cbiAgICBpZiAoaXNMb2dpbiB8fCBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIpIHtcbiAgICAgIC8vIG5vIHVzZXIgbWFraW5nIHRoZSBjYWxsXG4gICAgICAvLyBPUiB0aGUgdXNlciBtYWtpbmcgdGhlIGNhbGwgaXMgdGhlIHJpZ2h0IG9uZVxuICAgICAgLy8gTG9naW4gd2l0aCBhdXRoIGRhdGFcbiAgICAgIGRlbGV0ZSByZXN1bHRzWzBdLnBhc3N3b3JkO1xuXG4gICAgICAvLyBuZWVkIHRvIHNldCB0aGUgb2JqZWN0SWQgZmlyc3Qgb3RoZXJ3aXNlIGxvY2F0aW9uIGhhcyB0cmFpbGluZyB1bmRlZmluZWRcbiAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCA9IHVzZXJSZXN1bHQub2JqZWN0SWQ7XG5cbiAgICAgIGlmICghdGhpcy5xdWVyeSB8fCAhdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgIHJlc3BvbnNlOiB1c2VyUmVzdWx0LFxuICAgICAgICAgIGxvY2F0aW9uOiB0aGlzLmxvY2F0aW9uKCksXG4gICAgICAgIH07XG4gICAgICAgIC8vIFJ1biBiZWZvcmVMb2dpbiBob29rIGJlZm9yZSBzdG9yaW5nIGFueSB1cGRhdGVzXG4gICAgICAgIC8vIHRvIGF1dGhEYXRhIG9uIHRoZSBkYjsgY2hhbmdlcyB0byB1c2VyUmVzdWx0XG4gICAgICAgIC8vIHdpbGwgYmUgaWdub3JlZC5cbiAgICAgICAgYXdhaXQgdGhpcy5ydW5CZWZvcmVMb2dpblRyaWdnZXIoc3RydWN0dXJlZENsb25lKHVzZXJSZXN1bHQpKTtcblxuICAgICAgICAvLyBJZiB3ZSBhcmUgaW4gbG9naW4gb3BlcmF0aW9uIHZpYSBhdXRoRGF0YVxuICAgICAgICAvLyB3ZSBuZWVkIHRvIGJlIHN1cmUgdGhhdCB0aGUgdXNlciBoYXMgcHJvdmlkZWRcbiAgICAgICAgLy8gcmVxdWlyZWQgYXV0aERhdGFcbiAgICAgICAgQXV0aC5jaGVja0lmVXNlckhhc1Byb3ZpZGVkQ29uZmlndXJlZFByb3ZpZGVyc0ZvckxvZ2luKFxuICAgICAgICAgIHsgY29uZmlnOiB0aGlzLmNvbmZpZywgYXV0aDogdGhpcy5hdXRoIH0sXG4gICAgICAgICAgYXV0aERhdGEsXG4gICAgICAgICAgdXNlclJlc3VsdC5hdXRoRGF0YSxcbiAgICAgICAgICB0aGlzLmNvbmZpZ1xuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICAvLyBQcmV2ZW50IHZhbGlkYXRpbmcgaWYgbm8gbXV0YXRlZCBkYXRhIGRldGVjdGVkIG9uIHVwZGF0ZVxuICAgICAgaWYgKCFoYXNNdXRhdGVkQXV0aERhdGEgJiYgaXNDdXJyZW50VXNlckxvZ2dlZE9yTWFzdGVyKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gQWx3YXlzIHZhbGlkYXRlIGFsbCBwcm92aWRlZCBhdXRoRGF0YSBvbiBsb2dpbiB0byBwcmV2ZW50IGF1dGhlbnRpY2F0aW9uXG4gICAgICAvLyBieXBhc3MgdmlhIHBhcnRpYWwgYXV0aERhdGEgKGUuZy4gc2VuZGluZyBvbmx5IHRoZSBwcm92aWRlciBJRCB3aXRob3V0XG4gICAgICAvLyBhbiBhY2Nlc3MgdG9rZW4pOyBvbiB1cGRhdGUgb25seSB2YWxpZGF0ZSBtdXRhdGVkIG9uZXNcbiAgICAgIGlmIChpc0xvZ2luIHx8IGhhc011dGF0ZWRBdXRoRGF0YSB8fCAhdGhpcy5jb25maWcuYWxsb3dFeHBpcmVkQXV0aERhdGFUb2tlbikge1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihcbiAgICAgICAgICBpc0xvZ2luID8gYXV0aERhdGEgOiBtdXRhdGVkQXV0aERhdGEsXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICB1c2VyUmVzdWx0XG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGF0YS5hdXRoRGF0YSA9IHJlcy5hdXRoRGF0YTtcbiAgICAgICAgdGhpcy5hdXRoRGF0YVJlc3BvbnNlID0gcmVzLmF1dGhEYXRhUmVzcG9uc2U7XG4gICAgICB9XG5cbiAgICAgIC8vIENhcHR1cmUgb3JpZ2luYWwgYXV0aERhdGEgYmVmb3JlIG11dGF0aW5nIHVzZXJSZXN1bHQgdmlhIHRoZSByZXNwb25zZSByZWZlcmVuY2VcbiAgICAgIGNvbnN0IG9yaWdpbmFsQXV0aERhdGEgPSB1c2VyUmVzdWx0Py5hdXRoRGF0YVxuICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgICBPYmplY3QuZW50cmllcyh1c2VyUmVzdWx0LmF1dGhEYXRhKS5tYXAoKFtrLCB2XSkgPT5cbiAgICAgICAgICAgIFtrLCB2ICYmIHR5cGVvZiB2ID09PSAnb2JqZWN0JyA/IHsgLi4udiB9IDogdl1cbiAgICAgICAgICApXG4gICAgICAgIClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICAgIC8vIElGIHdlIGFyZSBpbiBsb2dpbiB3ZSdsbCBza2lwIHRoZSBkYXRhYmFzZSBvcGVyYXRpb24gLyBiZWZvcmVTYXZlIC8gYWZ0ZXJTYXZlIGV0Yy4uLlxuICAgICAgLy8gd2UgbmVlZCB0byBzZXQgaXQgdXAgdGhlcmUuXG4gICAgICAvLyBXZSBhcmUgc3VwcG9zZWQgdG8gaGF2ZSBhIHJlc3BvbnNlIG9ubHkgb24gTE9HSU4gd2l0aCBhdXRoRGF0YSwgc28gd2Ugc2tpcCB0aG9zZVxuICAgICAgLy8gSWYgd2UncmUgbm90IGxvZ2dpbmcgaW4sIGJ1dCBqdXN0IHVwZGF0aW5nIHRoZSBjdXJyZW50IHVzZXIsIHdlIGNhbiBzYWZlbHkgc2tpcCB0aGF0IHBhcnRcbiAgICAgIGlmICh0aGlzLnJlc3BvbnNlKSB7XG4gICAgICAgIC8vIEFzc2lnbiB0aGUgbmV3IGF1dGhEYXRhIGluIHRoZSByZXNwb25zZVxuICAgICAgICBPYmplY3Qua2V5cyhtdXRhdGVkQXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UuYXV0aERhdGFbcHJvdmlkZXJdID0gbXV0YXRlZEF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gUnVuIHRoZSBEQiB1cGRhdGUgZGlyZWN0bHksIGFzICdtYXN0ZXInIG9ubHkgaWYgYXV0aERhdGEgY29udGFpbnMgc29tZSBrZXlzXG4gICAgICAgIC8vIGF1dGhEYXRhIGNvdWxkIG5vdCBjb250YWlucyBrZXlzIGFmdGVyIHZhbGlkYXRpb24gaWYgdGhlIGF1dGhBZGFwdGVyXG4gICAgICAgIC8vIHVzZXMgdGhlIGBkb05vdFNhdmVgIG9wdGlvbi4gSnVzdCB1cGRhdGUgdGhlIGF1dGhEYXRhIHBhcnRcbiAgICAgICAgLy8gVGhlbiB3ZSdyZSBnb29kIGZvciB0aGUgdXNlciwgZWFybHkgZXhpdCBvZiBzb3J0c1xuICAgICAgICBpZiAoT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGgpIHtcbiAgICAgICAgICBjb25zdCBxdWVyeSA9IHsgb2JqZWN0SWQ6IHRoaXMuZGF0YS5vYmplY3RJZCB9O1xuICAgICAgICAgIC8vIE9wdGltaXN0aWMgbG9ja2luZzogaW5jbHVkZSBlYWNoIGNoYW5nZWQgb3JpZ2luYWwgZmllbGQgaW4gdGhlIFdIRVJFIGNsYXVzZVxuICAgICAgICAgIC8vIGZvciBwcm92aWRlcnMgd2hvc2UgZGF0YSBpcyBiZWluZyB1cGRhdGVkLiBUaGlzIHByZXZlbnRzIGNvbmN1cnJlbnQgcmVxdWVzdHNcbiAgICAgICAgICAvLyBmcm9tIGJvdGggc3VjY2VlZGluZyB3aGVuIGNvbnN1bWluZyBzaW5nbGUtdXNlIHRva2VucyAoZS5nLiBNRkEgcmVjb3ZlcnkgY29kZXNcbiAgICAgICAgICAvLyBhcyBhcnJheXMsIG9yIE1GQSBTTVMgT1RQIHRva2VucyBhcyBzdHJpbmdzKS5cbiAgICAgICAgICBhcHBseUF1dGhEYXRhT3B0aW1pc3RpY0xvY2socXVlcnksIG9yaWdpbmFsQXV0aERhdGEsIHRoaXMuZGF0YS5hdXRoRGF0YSk7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZShcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICB7IGF1dGhEYXRhOiB0aGlzLmRhdGEuYXV0aERhdGEgfSxcbiAgICAgICAgICAgICAge31cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGlmIChlcnJvci5jb2RlID09PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELCAnSW52YWxpZCBhdXRoIGRhdGEnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuX3Rocm93SWZBdXRoRGF0YUR1cGxpY2F0ZShlcnJvcik7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLmRhdGEuYXV0aERhdGEgJiYgT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGgpIHtcbiAgICAgICAgLy8gVVBEQVRFIHBhdGggKGUuZy4gUFVUIC91c2Vycy86aWQgZHVyaW5nIGxpbmtlZC1wcm92aWRlciByZS1hdXRoKTogYXBwbHlcbiAgICAgICAgLy8gdGhlIHNhbWUgb3B0aW1pc3RpYyBsb2NrIHRvIHRoZSBzdWJzZXF1ZW50IHJ1bkRhdGFiYXNlT3BlcmF0aW9uIHVwZGF0ZSBzb1xuICAgICAgICAvLyBjb25jdXJyZW50IHNpbmdsZS11c2UgdG9rZW4gY29uc3VtZXJzIGNhbm5vdCBib3RoIHN1Y2NlZWQuXG4gICAgICAgIGFwcGx5QXV0aERhdGFPcHRpbWlzdGljTG9jayh0aGlzLnF1ZXJ5LCBvcmlnaW5hbEF1dGhEYXRhLCB0aGlzLmRhdGEuYXV0aERhdGEpO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jaGVja1Jlc3RyaWN0ZWRGaWVsZHMgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAnZW1haWxWZXJpZmllZCcgaW4gdGhpcy5kYXRhKSB7XG4gICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgXCJDbGllbnRzIGFyZW4ndCBhbGxvd2VkIHRvIG1hbnVhbGx5IHVwZGF0ZSBlbWFpbCB2ZXJpZmljYXRpb24uXCIsXG4gICAgICB0aGlzLmNvbmZpZ1xuICAgICk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGUgY3JlYXRlIGNsYXNzLWxldmVsIHBlcm1pc3Npb24gYmVmb3JlIHRyYW5zZm9ybVVzZXIgcnVucy5cbi8vIFRoaXMgcHJldmVudHMgdXNlciBlbnVtZXJhdGlvbiAodXNlcm5hbWUvZW1haWwgZXhpc3RlbmNlKSB3aGVuIHB1YmxpY1xuLy8gY3JlYXRlIGlzIGRpc2FibGVkIG9uIF9Vc2VyLCBiZWNhdXNlIHRyYW5zZm9ybVVzZXIgY2hlY2tzIHVuaXF1ZW5lc3Ncbi8vIGJlZm9yZSB0aGUgQ0xQIGlzIGVuZm9yY2VkIGluIHJ1bkRhdGFiYXNlT3BlcmF0aW9uLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUNyZWF0ZVBlcm1pc3Npb24gPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnF1ZXJ5IHx8IHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0aGlzLnJ1bk9wdGlvbnMuYWNsIHx8IFtdLFxuICAgICdjcmVhdGUnXG4gICk7XG59O1xuXG4vLyBUaGUgbm9uLXRoaXJkLXBhcnR5IHBhcnRzIG9mIFVzZXIgdHJhbnNmb3JtYXRpb25cblJlc3RXcml0ZS5wcm90b3R5cGUudHJhbnNmb3JtVXNlciA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgdmFyIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cblxuICAvLyBEbyBub3QgY2xlYW51cCBzZXNzaW9uIGlmIG9iamVjdElkIGlzIG5vdCBzZXRcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5vYmplY3RJZCgpKSB7XG4gICAgLy8gSWYgd2UncmUgdXBkYXRpbmcgYSBfVXNlciBvYmplY3QsIHdlIG5lZWQgdG8gY2xlYXIgb3V0IHRoZSBjYWNoZSBmb3IgdGhhdCB1c2VyLiBGaW5kIGFsbCB0aGVpclxuICAgIC8vIHNlc3Npb24gdG9rZW5zLCBhbmQgcmVtb3ZlIHRoZW0gZnJvbSB0aGUgY2FjaGUuXG4gICAgY29uc3QgcXVlcnkgPSBhd2FpdCBSZXN0UXVlcnkoe1xuICAgICAgbWV0aG9kOiBSZXN0UXVlcnkuTWV0aG9kLmZpbmQsXG4gICAgICBjb25maWc6IHRoaXMuY29uZmlnLFxuICAgICAgYXV0aDogQXV0aC5tYXN0ZXIodGhpcy5jb25maWcpLFxuICAgICAgY2xhc3NOYW1lOiAnX1Nlc3Npb24nLFxuICAgICAgcnVuQmVmb3JlRmluZDogZmFsc2UsXG4gICAgICByZXN0V2hlcmU6IHtcbiAgICAgICAgdXNlcjoge1xuICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgICBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBwcm9taXNlID0gcXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICByZXN1bHRzLnJlc3VsdHMuZm9yRWFjaChzZXNzaW9uID0+XG4gICAgICAgIHRoaXMuY29uZmlnLmNhY2hlQ29udHJvbGxlci51c2VyLmRlbChzZXNzaW9uLnNlc3Npb25Ub2tlbilcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIFRyYW5zZm9ybSB0aGUgcGFzc3dvcmRcbiAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBpZ25vcmUgb25seSBpZiB1bmRlZmluZWQuIHNob3VsZCBwcm9jZWVkIGlmIGVtcHR5ICgnJylcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSA9IHRydWU7XG4gICAgICAgIC8vIEdlbmVyYXRlIGEgbmV3IHNlc3Npb24gb25seSBpZiB0aGUgdXNlciByZXF1ZXN0ZWRcbiAgICAgICAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgICAgICAgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXSA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3koKS50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHBhc3N3b3JkQ3J5cHRvLmhhc2godGhpcy5kYXRhLnBhc3N3b3JkKS50aGVuKGhhc2hlZFBhc3N3b3JkID0+IHtcbiAgICAgICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCA9IGhhc2hlZFBhc3N3b3JkO1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEucGFzc3dvcmQ7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVVc2VyTmFtZSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlRW1haWwoKTtcbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlVXNlck5hbWUgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIENoZWNrIGZvciB1c2VybmFtZSB1bmlxdWVuZXNzXG4gIGlmICghdGhpcy5kYXRhLnVzZXJuYW1lKSB7XG4gICAgaWYgKCF0aGlzLnF1ZXJ5KSB7XG4gICAgICB0aGlzLmRhdGEudXNlcm5hbWUgPSBjcnlwdG9VdGlscy5yYW5kb21TdHJpbmcoMjUpO1xuICAgICAgdGhpcy5yZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSA9IHRydWU7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvKlxuICAgIFVzZXJuYW1lcyBzaG91bGQgYmUgdW5pcXVlIHdoZW4gY29tcGFyZWQgY2FzZSBpbnNlbnNpdGl2ZWx5XG5cbiAgICBVc2VycyBzaG91bGQgYmUgYWJsZSB0byBtYWtlIGNhc2Ugc2Vuc2l0aXZlIHVzZXJuYW1lcyBhbmRcbiAgICBsb2dpbiB1c2luZyB0aGUgY2FzZSB0aGV5IGVudGVyZWQuICBJLmUuICdTbm9vcHknIHNob3VsZCBwcmVjbHVkZVxuICAgICdzbm9vcHknIGFzIGEgdmFsaWQgdXNlcm5hbWUuXG4gICovXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5maW5kKFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB7XG4gICAgICAgIHVzZXJuYW1lOiB0aGlzLmRhdGEudXNlcm5hbWUsXG4gICAgICAgIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICB9LFxuICAgICAgeyBsaW1pdDogMSwgY2FzZUluc2Vuc2l0aXZlOiB0cnVlIH0sXG4gICAgICB7fSxcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfVEFLRU4sXG4gICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLmJ1aWxkQ3JlYXRlZFdpdGggPSBmdW5jdGlvbiAoYWN0aW9uLCBhdXRoUHJvdmlkZXIpIHtcbiAgcmV0dXJuIHsgYWN0aW9uLCBhdXRoUHJvdmlkZXI6IGF1dGhQcm92aWRlciB8fCAncGFzc3dvcmQnIH07XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmdldENyZWF0ZWRXaXRoID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5zdG9yYWdlLmNyZWF0ZWRXaXRoKSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmFnZS5jcmVhdGVkV2l0aDtcbiAgfVxuICBjb25zdCBpc0NyZWF0ZU9wZXJhdGlvbiA9ICF0aGlzLnF1ZXJ5O1xuICBjb25zdCBhdXRoRGF0YVByb3ZpZGVyID1cbiAgICB0aGlzLmRhdGE/LmF1dGhEYXRhICYmXG4gICAgT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGggJiZcbiAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmpvaW4oJywnKTtcbiAgY29uc3QgYXV0aFByb3ZpZGVyID0gdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciB8fCBhdXRoRGF0YVByb3ZpZGVyO1xuICAvLyBzdG9yYWdlLmF1dGhQcm92aWRlciBpcyBvbmx5IHNldCBmb3IgbG9naW4gKGV4aXN0aW5nIHVzZXIgZm91bmQgaW4gaGFuZGxlQXV0aERhdGEpXG4gIGNvbnN0IGFjdGlvbiA9IHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgPyAnbG9naW4nIDogaXNDcmVhdGVPcGVyYXRpb24gPyAnc2lnbnVwJyA6IHVuZGVmaW5lZDtcbiAgaWYgKCFhY3Rpb24pIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcmVzb2x2ZWRBdXRoUHJvdmlkZXIgPSBhdXRoUHJvdmlkZXIgfHwgKGFjdGlvbiA9PT0gJ3NpZ251cCcgPyAncGFzc3dvcmQnIDogdW5kZWZpbmVkKTtcbiAgdGhpcy5zdG9yYWdlLmNyZWF0ZWRXaXRoID0gUmVzdFdyaXRlLmJ1aWxkQ3JlYXRlZFdpdGgoYWN0aW9uLCByZXNvbHZlZEF1dGhQcm92aWRlcik7XG4gIHJldHVybiB0aGlzLnN0b3JhZ2UuY3JlYXRlZFdpdGg7XG59O1xuXG4vKlxuICBBcyB3aXRoIHVzZXJuYW1lcywgUGFyc2Ugc2hvdWxkIG5vdCBhbGxvdyBjYXNlIGluc2Vuc2l0aXZlIGNvbGxpc2lvbnMgb2YgZW1haWwuXG4gIHVubGlrZSB3aXRoIHVzZXJuYW1lcyAod2hpY2ggY2FuIGhhdmUgY2FzZSBpbnNlbnNpdGl2ZSBjb2xsaXNpb25zIGluIHRoZSBjYXNlIG9mXG4gIGF1dGggYWRhcHRlcnMpLCBlbWFpbHMgc2hvdWxkIG5ldmVyIGhhdmUgYSBjYXNlIGluc2Vuc2l0aXZlIGNvbGxpc2lvbi5cblxuICBUaGlzIGJlaGF2aW9yIGNhbiBiZSBlbmZvcmNlZCB0aHJvdWdoIGEgcHJvcGVybHkgY29uZmlndXJlZCBpbmRleCBzZWU6XG4gIGh0dHBzOi8vZG9jcy5tb25nb2RiLmNvbS9tYW51YWwvY29yZS9pbmRleC1jYXNlLWluc2Vuc2l0aXZlLyNjcmVhdGUtYS1jYXNlLWluc2Vuc2l0aXZlLWluZGV4XG4gIHdoaWNoIGNvdWxkIGJlIGltcGxlbWVudGVkIGluc3RlYWQgb2YgdGhpcyBjb2RlIGJhc2VkIHZhbGlkYXRpb24uXG5cbiAgR2l2ZW4gdGhhdCB0aGlzIGxvb2t1cCBzaG91bGQgYmUgYSByZWxhdGl2ZWx5IGxvdyB1c2UgY2FzZSBhbmQgdGhhdCB0aGUgY2FzZSBzZW5zaXRpdmVcbiAgdW5pcXVlIGluZGV4IHdpbGwgYmUgdXNlZCBieSB0aGUgZGIgZm9yIHRoZSBxdWVyeSwgdGhpcyBpcyBhbiBhZGVxdWF0ZSBzb2x1dGlvbi5cbiovXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZUVtYWlsID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuZGF0YS5lbWFpbCB8fCB0aGlzLmRhdGEuZW1haWwuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gVmFsaWRhdGUgYmFzaWMgZW1haWwgYWRkcmVzcyBmb3JtYXRcbiAgaWYgKCF0aGlzLmRhdGEuZW1haWwubWF0Y2goL14uK0AuKyQvKSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0VNQUlMX0FERFJFU1MsICdFbWFpbCBhZGRyZXNzIGZvcm1hdCBpcyBpbnZhbGlkLicpXG4gICAgKTtcbiAgfVxuICAvLyBDYXNlIGluc2Vuc2l0aXZlIG1hdGNoLCBzZWUgbm90ZSBhYm92ZSBmdW5jdGlvbi5cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHtcbiAgICAgICAgZW1haWw6IHRoaXMuZGF0YS5lbWFpbCxcbiAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgIH0sXG4gICAgICB7IGxpbWl0OiAxLCBjYXNlSW5zZW5zaXRpdmU6IHRydWUgfSxcbiAgICAgIHt9LFxuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgIXRoaXMuZGF0YS5hdXRoRGF0YSB8fFxuICAgICAgICAhT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGggfHxcbiAgICAgICAgKE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoID09PSAxICYmXG4gICAgICAgICAgT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKVswXSA9PT0gJ2Fub255bW91cycpXG4gICAgICApIHtcbiAgICAgICAgLy8gV2UgdXBkYXRlZCB0aGUgZW1haWwsIHNlbmQgYSBuZXcgdmFsaWRhdGlvblxuICAgICAgICBjb25zdCB7IG9yaWdpbmFsT2JqZWN0LCB1cGRhdGVkT2JqZWN0IH0gPSB0aGlzLmJ1aWxkUGFyc2VPYmplY3RzKCk7XG4gICAgICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICAgICAgb3JpZ2luYWw6IG9yaWdpbmFsT2JqZWN0LFxuICAgICAgICAgIG9iamVjdDogdXBkYXRlZE9iamVjdCxcbiAgICAgICAgICBtYXN0ZXI6IHRoaXMuYXV0aC5pc01hc3RlcixcbiAgICAgICAgICBpcDogdGhpcy5jb25maWcuaXAsXG4gICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICBjcmVhdGVkV2l0aDogdGhpcy5nZXRDcmVhdGVkV2l0aCgpLFxuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gdGhpcy5jb25maWcudXNlckNvbnRyb2xsZXIuc2V0RW1haWxWZXJpZnlUb2tlbih0aGlzLmRhdGEsIHJlcXVlc3QsIHRoaXMuc3RvcmFnZSk7XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkUG9saWN5ID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5KSB7IHJldHVybiBQcm9taXNlLnJlc29sdmUoKTsgfVxuICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cygpLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSgpO1xuICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIGNoZWNrIGlmIHRoZSBwYXNzd29yZCBjb25mb3JtcyB0byB0aGUgZGVmaW5lZCBwYXNzd29yZCBwb2xpY3kgaWYgY29uZmlndXJlZFxuICAvLyBJZiB3ZSBzcGVjaWZpZWQgYSBjdXN0b20gZXJyb3IgaW4gb3VyIGNvbmZpZ3VyYXRpb24gdXNlIGl0LlxuICAvLyBFeGFtcGxlOiBcIlBhc3N3b3JkcyBtdXN0IGluY2x1ZGUgYSBDYXBpdGFsIExldHRlciwgTG93ZXJjYXNlIExldHRlciwgYW5kIGEgbnVtYmVyLlwiXG4gIC8vXG4gIC8vIFRoaXMgaXMgZXNwZWNpYWxseSB1c2VmdWwgb24gdGhlIGdlbmVyaWMgXCJwYXNzd29yZCByZXNldFwiIHBhZ2UsXG4gIC8vIGFzIGl0IGFsbG93cyB0aGUgcHJvZ3JhbW1lciB0byBjb21tdW5pY2F0ZSBzcGVjaWZpYyByZXF1aXJlbWVudHMgaW5zdGVhZCBvZjpcbiAgLy8gYS4gbWFraW5nIHRoZSB1c2VyIGd1ZXNzIHdoYXRzIHdyb25nXG4gIC8vIGIuIG1ha2luZyBhIGN1c3RvbSBwYXNzd29yZCByZXNldCBwYWdlIHRoYXQgc2hvd3MgdGhlIHJlcXVpcmVtZW50c1xuICBjb25zdCBwb2xpY3lFcnJvciA9IHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRpb25FcnJvclxuICAgID8gdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdGlvbkVycm9yXG4gICAgOiAnUGFzc3dvcmQgZG9lcyBub3QgbWVldCB0aGUgUGFzc3dvcmQgUG9saWN5IHJlcXVpcmVtZW50cy4nO1xuICBjb25zdCBjb250YWluc1VzZXJuYW1lRXJyb3IgPSAnUGFzc3dvcmQgY2Fubm90IGNvbnRhaW4geW91ciB1c2VybmFtZS4nO1xuXG4gIC8vIGNoZWNrIHdoZXRoZXIgdGhlIHBhc3N3b3JkIG1lZXRzIHRoZSBwYXNzd29yZCBzdHJlbmd0aCByZXF1aXJlbWVudHNcbiAgaWYgKFxuICAgICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yICYmXG4gICAgICAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kucGF0dGVyblZhbGlkYXRvcih0aGlzLmRhdGEucGFzc3dvcmQpKSB8fFxuICAgICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayAmJlxuICAgICAgIXRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRvckNhbGxiYWNrKHRoaXMuZGF0YS5wYXNzd29yZCkpXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUiwgcG9saWN5RXJyb3IpKTtcbiAgfVxuXG4gIC8vIGNoZWNrIHdoZXRoZXIgcGFzc3dvcmQgY29udGFpbiB1c2VybmFtZVxuICBpZiAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kuZG9Ob3RBbGxvd1VzZXJuYW1lID09PSB0cnVlKSB7XG4gICAgaWYgKHRoaXMuZGF0YS51c2VybmFtZSkge1xuICAgICAgLy8gdXNlcm5hbWUgaXMgbm90IHBhc3NlZCBkdXJpbmcgcGFzc3dvcmQgcmVzZXRcbiAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQuaW5kZXhPZih0aGlzLmRhdGEudXNlcm5hbWUpID49IDApXG4gICAgICB7IHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUiwgY29udGFpbnNVc2VybmFtZUVycm9yKSk7IH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gcmV0cmlldmUgdGhlIFVzZXIgb2JqZWN0IHVzaW5nIG9iamVjdElkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoJ19Vc2VyJywgeyBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpIH0pLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQuaW5kZXhPZihyZXN1bHRzWzBdLnVzZXJuYW1lKSA+PSAwKVxuICAgICAgICB7IHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUiwgY29udGFpbnNVc2VybmFtZUVycm9yKVxuICAgICAgICApOyB9XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBpcyByZXBlYXRpbmcgZnJvbSBzcGVjaWZpZWQgaGlzdG9yeVxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkpIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5maW5kKFxuICAgICAgICAnX1VzZXInLFxuICAgICAgICB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgeyBrZXlzOiBbJ19wYXNzd29yZF9oaXN0b3J5JywgJ19oYXNoZWRfcGFzc3dvcmQnXSB9LFxuICAgICAgICBBdXRoLm1haW50ZW5hbmNlKHRoaXMuY29uZmlnKVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICBsZXQgb2xkUGFzc3dvcmRzID0gW107XG4gICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KVxuICAgICAgICB7IG9sZFBhc3N3b3JkcyA9IF8udGFrZShcbiAgICAgICAgICB1c2VyLl9wYXNzd29yZF9oaXN0b3J5LFxuICAgICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDFcbiAgICAgICAgKTsgfVxuICAgICAgICBvbGRQYXNzd29yZHMucHVzaCh1c2VyLnBhc3N3b3JkKTtcbiAgICAgICAgY29uc3QgbmV3UGFzc3dvcmQgPSB0aGlzLmRhdGEucGFzc3dvcmQ7XG4gICAgICAgIC8vIGNvbXBhcmUgdGhlIG5ldyBwYXNzd29yZCBoYXNoIHdpdGggYWxsIG9sZCBwYXNzd29yZCBoYXNoZXNcbiAgICAgICAgY29uc3QgcHJvbWlzZXMgPSBvbGRQYXNzd29yZHMubWFwKGZ1bmN0aW9uIChoYXNoKSB7XG4gICAgICAgICAgcmV0dXJuIHBhc3N3b3JkQ3J5cHRvLmNvbXBhcmUobmV3UGFzc3dvcmQsIGhhc2gpLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHQpXG4gICAgICAgICAgICAvLyByZWplY3QgaWYgdGhlcmUgaXMgYSBtYXRjaFxuICAgICAgICAgICAgeyByZXR1cm4gUHJvbWlzZS5yZWplY3QoJ1JFUEVBVF9QQVNTV09SRCcpOyB9XG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgICAvLyB3YWl0IGZvciBhbGwgY29tcGFyaXNvbnMgdG8gY29tcGxldGVcbiAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKVxuICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgaWYgKGVyciA9PT0gJ1JFUEVBVF9QQVNTV09SRCcpXG4gICAgICAgICAgICAvLyBhIG1hdGNoIHdhcyBmb3VuZFxuICAgICAgICAgICAgeyByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgIGBOZXcgcGFzc3dvcmQgc2hvdWxkIG5vdCBiZSB0aGUgc2FtZSBhcyBsYXN0ICR7dGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5fSBwYXNzd29yZHMuYFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApOyB9XG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gRG9uJ3QgZ2VuZXJhdGUgc2Vzc2lvbiBmb3IgdXBkYXRpbmcgdXNlciAodGhpcy5xdWVyeSBpcyBzZXQpIHVubGVzcyBhdXRoRGF0YSBleGlzdHNcbiAgaWYgKHRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEb24ndCBnZW5lcmF0ZSBuZXcgc2Vzc2lvblRva2VuIGlmIGxpbmtpbmcgdmlhIHNlc3Npb25Ub2tlblxuICBpZiAodGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIElmIHNpZ24tdXAgY2FsbFxuICBpZiAoIXRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIpIHtcbiAgICAvLyBDcmVhdGUgcmVxdWVzdCBvYmplY3QgZm9yIHZlcmlmaWNhdGlvbiBmdW5jdGlvbnNcbiAgICBjb25zdCB7IG9yaWdpbmFsT2JqZWN0LCB1cGRhdGVkT2JqZWN0IH0gPSB0aGlzLmJ1aWxkUGFyc2VPYmplY3RzKCk7XG4gICAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAgIG9yaWdpbmFsOiBvcmlnaW5hbE9iamVjdCxcbiAgICAgIG9iamVjdDogdXBkYXRlZE9iamVjdCxcbiAgICAgIG1hc3RlcjogdGhpcy5hdXRoLmlzTWFzdGVyLFxuICAgICAgaXA6IHRoaXMuY29uZmlnLmlwLFxuICAgICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgICAgIGNyZWF0ZWRXaXRoOiB0aGlzLmdldENyZWF0ZWRXaXRoKCksXG4gICAgfTtcbiAgICAvLyBHZXQgdmVyaWZpY2F0aW9uIGNvbmRpdGlvbnMgd2hpY2ggY2FuIGJlIGJvb2xlYW5zIG9yIGZ1bmN0aW9uczsgdGhlIHB1cnBvc2Ugb2YgdGhpcyBhc3luYy9hd2FpdFxuICAgIC8vIHN0cnVjdHVyZSBpcyB0byBhdm9pZCB1bm5lY2Vzc2FyaWx5IGV4ZWN1dGluZyBzdWJzZXF1ZW50IGZ1bmN0aW9ucyBpZiBwcmV2aW91cyBvbmVzIGZhaWwgaW4gdGhlXG4gICAgLy8gY29uZGl0aW9uYWwgc3RhdGVtZW50IGJlbG93LCBhcyBhIGRldmVsb3BlciBtYXkgZGVjaWRlIHRvIGV4ZWN1dGUgZXhwZW5zaXZlIG9wZXJhdGlvbnMgaW4gdGhlbVxuICAgIGNvbnN0IHZlcmlmeVVzZXJFbWFpbHMgPSBhc3luYyAoKSA9PiB0aGlzLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzID09PSB0cnVlIHx8ICh0eXBlb2YgdGhpcy5jb25maWcudmVyaWZ5VXNlckVtYWlscyA9PT0gJ2Z1bmN0aW9uJyAmJiBhd2FpdCBQcm9taXNlLnJlc29sdmUodGhpcy5jb25maWcudmVyaWZ5VXNlckVtYWlscyhyZXF1ZXN0KSkgPT09IHRydWUpO1xuICAgIGNvbnN0IHByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPSBhc3luYyAoKSA9PiB0aGlzLmNvbmZpZy5wcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID09PSB0cnVlIHx8ICh0eXBlb2YgdGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCA9PT0gJ2Z1bmN0aW9uJyAmJiBhd2FpdCBQcm9taXNlLnJlc29sdmUodGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbChyZXF1ZXN0KSkgPT09IHRydWUpO1xuICAgIC8vIElmIHZlcmlmaWNhdGlvbiBpcyByZXF1aXJlZFxuICAgIGlmIChhd2FpdCB2ZXJpZnlVc2VyRW1haWxzKCkgJiYgYXdhaXQgcHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCgpKSB7XG4gICAgICB0aGlzLnN0b3JhZ2UucmVqZWN0U2lnbnVwID0gdHJ1ZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNyZWF0ZVNlc3Npb25Ub2tlbiA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgLy8gY2xvdWQgaW5zdGFsbGF0aW9uSWQgZnJvbSBDbG91ZCBDb2RlLFxuICAvLyBuZXZlciBjcmVhdGUgc2Vzc2lvbiB0b2tlbnMgZnJvbSB0aGVyZS5cbiAgaWYgKHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCAmJiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQgPT09ICdjbG91ZCcpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA9PSBudWxsICYmIHRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmpvaW4oJywnKTtcbiAgICAvLyBJbnZhbGlkYXRlIGNhY2hlZCBjcmVhdGVkV2l0aCBzaW5jZSBhdXRoUHJvdmlkZXIgd2FzIGp1c3QgcmVzb2x2ZWRcbiAgICBkZWxldGUgdGhpcy5zdG9yYWdlLmNyZWF0ZWRXaXRoO1xuICB9XG5cbiAgY29uc3QgY3JlYXRlZFdpdGggPSB0aGlzLmdldENyZWF0ZWRXaXRoKCk7XG4gIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IFJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uKHRoaXMuY29uZmlnLCB7XG4gICAgdXNlcklkOiB0aGlzLm9iamVjdElkKCksXG4gICAgY3JlYXRlZFdpdGgsXG4gICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgfSk7XG5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2Uuc2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcbn07XG5cblJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uID0gZnVuY3Rpb24gKFxuICBjb25maWcsXG4gIHsgdXNlcklkLCBjcmVhdGVkV2l0aCwgaW5zdGFsbGF0aW9uSWQsIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSB9XG4pIHtcbiAgY29uc3QgdG9rZW4gPSAncjonICsgY3J5cHRvVXRpbHMubmV3VG9rZW4oKTtcbiAgY29uc3QgZXhwaXJlc0F0ID0gY29uZmlnLmdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCgpO1xuICBjb25zdCBzZXNzaW9uRGF0YSA9IHtcbiAgICBzZXNzaW9uVG9rZW46IHRva2VuLFxuICAgIHVzZXI6IHtcbiAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgb2JqZWN0SWQ6IHVzZXJJZCxcbiAgICB9LFxuICAgIGNyZWF0ZWRXaXRoLFxuICAgIGV4cGlyZXNBdDogUGFyc2UuX2VuY29kZShleHBpcmVzQXQpLFxuICB9O1xuXG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIHNlc3Npb25EYXRhLmluc3RhbGxhdGlvbklkID0gaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBPYmplY3QuYXNzaWduKHNlc3Npb25EYXRhLCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEpO1xuXG4gIHJldHVybiB7XG4gICAgc2Vzc2lvbkRhdGEsXG4gICAgY3JlYXRlU2Vzc2lvbjogKCkgPT5cbiAgICAgIG5ldyBSZXN0V3JpdGUoY29uZmlnLCBBdXRoLm1hc3Rlcihjb25maWcpLCAnX1Nlc3Npb24nLCBudWxsLCBzZXNzaW9uRGF0YSkuZXhlY3V0ZSgpLFxuICB9O1xufTtcblxuLy8gRGVsZXRlIGVtYWlsIHJlc2V0IHRva2VucyBpZiB1c2VyIGlzIGNoYW5naW5nIHBhc3N3b3JkIG9yIGVtYWlsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZWxldGVFbWFpbFJlc2V0VG9rZW5JZk5lZWRlZCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IHRoaXMucXVlcnkgPT09IG51bGwpIHtcbiAgICAvLyBudWxsIHF1ZXJ5IG1lYW5zIGNyZWF0ZVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgncGFzc3dvcmQnIGluIHRoaXMuZGF0YSB8fCAnZW1haWwnIGluIHRoaXMuZGF0YSkge1xuICAgIGNvbnN0IGFkZE9wcyA9IHtcbiAgICAgIF9wZXJpc2hhYmxlX3Rva2VuOiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgICBfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0OiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgfTtcbiAgICB0aGlzLmRhdGEgPSBPYmplY3QuYXNzaWduKHRoaXMuZGF0YSwgYWRkT3BzKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zID0gZnVuY3Rpb24gKCkge1xuICAvLyBPbmx5IGZvciBfU2Vzc2lvbiwgYW5kIGF0IGNyZWF0aW9uIHRpbWVcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9ICdfU2Vzc2lvbicgfHwgdGhpcy5xdWVyeSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEZXN0cm95IHRoZSBzZXNzaW9ucyBpbiAnQmFja2dyb3VuZCdcbiAgY29uc3QgeyB1c2VyLCBpbnN0YWxsYXRpb25JZCwgc2Vzc2lvblRva2VuIH0gPSB0aGlzLmRhdGE7XG4gIGlmICghdXNlciB8fCAhaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCF1c2VyLm9iamVjdElkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5kZXN0cm95KFxuICAgICdfU2Vzc2lvbicsXG4gICAge1xuICAgICAgdXNlcixcbiAgICAgIGluc3RhbGxhdGlvbklkLFxuICAgICAgc2Vzc2lvblRva2VuOiB7ICRuZTogc2Vzc2lvblRva2VuIH0sXG4gICAgfSxcbiAgICB7fSxcbiAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICApLmNhdGNoKGUgPT4ge1xuICAgIGlmIChlLmNvZGUgIT09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuICB9KTtcbn07XG5cbi8vIEhhbmRsZXMgYW55IGZvbGxvd3VwIGxvZ2ljXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUZvbGxvd3VwID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5zdG9yYWdlICYmIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddICYmIHRoaXMuY29uZmlnLnJldm9rZVNlc3Npb25PblBhc3N3b3JkUmVzZXQpIHtcbiAgICB2YXIgc2Vzc2lvblF1ZXJ5ID0ge1xuICAgICAgdXNlcjoge1xuICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpLFxuICAgICAgfSxcbiAgICB9O1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXTtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5kZXN0cm95KCdfU2Vzc2lvbicsIHNlc3Npb25RdWVyeSlcbiAgICAgIC50aGVuKHRoaXMuaGFuZGxlRm9sbG93dXAuYmluZCh0aGlzKSk7XG4gIH1cblxuICBpZiAodGhpcy5zdG9yYWdlICYmIHRoaXMuc3RvcmFnZVsnZ2VuZXJhdGVOZXdTZXNzaW9uJ10pIHtcbiAgICBkZWxldGUgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW4oKS50aGVuKHRoaXMuaGFuZGxlRm9sbG93dXAuYmluZCh0aGlzKSk7XG4gIH1cblxuICBpZiAodGhpcy5zdG9yYWdlICYmIHRoaXMuc3RvcmFnZVsnc2VuZFZlcmlmaWNhdGlvbkVtYWlsJ10pIHtcbiAgICBkZWxldGUgdGhpcy5zdG9yYWdlWydzZW5kVmVyaWZpY2F0aW9uRW1haWwnXTtcbiAgICAvLyBGaXJlIGFuZCBmb3JnZXQhXG4gICAgdGhpcy5jb25maWcudXNlckNvbnRyb2xsZXIuc2VuZFZlcmlmaWNhdGlvbkVtYWlsKHRoaXMuZGF0YSwgeyBhdXRoOiB0aGlzLmF1dGggfSk7XG4gICAgcmV0dXJuIHRoaXMuaGFuZGxlRm9sbG93dXAuYmluZCh0aGlzKTtcbiAgfVxufTtcblxuLy8gSGFuZGxlcyB0aGUgX1Nlc3Npb24gY2xhc3Mgc3BlY2lhbG5lc3MuXG4vLyBEb2VzIG5vdGhpbmcgaWYgdGhpcyBpc24ndCBhbiBfU2Vzc2lvbiBvYmplY3QuXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZVNlc3Npb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMuY2xhc3NOYW1lICE9PSAnX1Nlc3Npb24nKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGgudXNlciAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sICdTZXNzaW9uIHRva2VuIHJlcXVpcmVkLicpO1xuICB9XG5cbiAgLy8gVE9ETzogVmVyaWZ5IHByb3BlciBlcnJvciB0byB0aHJvd1xuICBpZiAoJ0FDTCcgaW4gdGhpcy5kYXRhKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdDYW5ub3Qgc2V0ICcgKyAnQUNMIG9uIGEgU2Vzc2lvbi4nKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgaWYgKCd1c2VyJyBpbiB0aGlzLmRhdGEgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiB0aGlzLmRhdGEudXNlcj8ub2JqZWN0SWQgIT09IHRoaXMuYXV0aC51c2VyLmlkKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0ludmFsaWQga2V5IG5hbWU6IHVzZXInKTtcbiAgICB9IGVsc2UgaWYgKCdpbnN0YWxsYXRpb25JZCcgaW4gdGhpcy5kYXRhKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0ludmFsaWQga2V5IG5hbWU6IGluc3RhbGxhdGlvbklkJyk7XG4gICAgfSBlbHNlIGlmICgnc2Vzc2lvblRva2VuJyBpbiB0aGlzLmRhdGEpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnSW52YWxpZCBrZXkgbmFtZTogc2Vzc2lvblRva2VuJyk7XG4gICAgfSBlbHNlIGlmICgnZXhwaXJlc0F0JyBpbiB0aGlzLmRhdGEgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnSW52YWxpZCBrZXkgbmFtZTogZXhwaXJlc0F0Jyk7XG4gICAgfSBlbHNlIGlmICgnY3JlYXRlZFdpdGgnIGluIHRoaXMuZGF0YSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdJbnZhbGlkIGtleSBuYW1lOiBjcmVhdGVkV2l0aCcpO1xuICAgIH1cbiAgICBpZiAoIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgICAgdGhpcy5xdWVyeSA9IHtcbiAgICAgICAgJGFuZDogW1xuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAge1xuICAgICAgICAgICAgdXNlcjoge1xuICAgICAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgICAgICBvYmplY3RJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIGNvbnN0IGFkZGl0aW9uYWxTZXNzaW9uRGF0YSA9IHt9O1xuICAgIGZvciAodmFyIGtleSBpbiB0aGlzLmRhdGEpIHtcbiAgICAgIGlmIChrZXkgPT09ICdvYmplY3RJZCcgfHwga2V5ID09PSAndXNlcicgfHwga2V5ID09PSAnc2Vzc2lvblRva2VuJyB8fCBrZXkgPT09ICdleHBpcmVzQXQnIHx8IGtleSA9PT0gJ2NyZWF0ZWRXaXRoJykge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGFkZGl0aW9uYWxTZXNzaW9uRGF0YVtrZXldID0gdGhpcy5kYXRhW2tleV07XG4gICAgfVxuXG4gICAgY29uc3QgeyBzZXNzaW9uRGF0YSwgY3JlYXRlU2Vzc2lvbiB9ID0gUmVzdFdyaXRlLmNyZWF0ZVNlc3Npb24odGhpcy5jb25maWcsIHtcbiAgICAgIHVzZXJJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICBjcmVhdGVkV2l0aDoge1xuICAgICAgICBhY3Rpb246ICdjcmVhdGUnLFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSxcbiAgICB9KTtcblxuICAgIHJldHVybiBjcmVhdGVTZXNzaW9uKCkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmICghcmVzdWx0cy5yZXNwb25zZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLCAnRXJyb3IgY3JlYXRpbmcgc2Vzc2lvbi4nKTtcbiAgICAgIH1cbiAgICAgIHNlc3Npb25EYXRhWydvYmplY3RJZCddID0gcmVzdWx0cy5yZXNwb25zZVsnb2JqZWN0SWQnXTtcbiAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICBsb2NhdGlvbjogcmVzdWx0cy5sb2NhdGlvbixcbiAgICAgICAgcmVzcG9uc2U6IHNlc3Npb25EYXRhLFxuICAgICAgfTtcbiAgICB9KTtcbiAgfVxufTtcblxuLy8gSGFuZGxlcyB0aGUgX0luc3RhbGxhdGlvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIGluc3RhbGxhdGlvbiBvYmplY3QuXG4vLyBJZiBhbiBpbnN0YWxsYXRpb24gaXMgZm91bmQsIHRoaXMgY2FuIG11dGF0ZSB0aGlzLnF1ZXJ5IGFuZCB0dXJuIGEgY3JlYXRlXG4vLyBpbnRvIGFuIHVwZGF0ZS5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlSW5zdGFsbGF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLmNsYXNzTmFtZSAhPT0gJ19JbnN0YWxsYXRpb24nKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKFxuICAgICF0aGlzLnF1ZXJ5ICYmXG4gICAgIXRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAhdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIDEzNSxcbiAgICAgICdhdCBsZWFzdCBvbmUgSUQgZmllbGQgKGRldmljZVRva2VuLCBpbnN0YWxsYXRpb25JZCkgJyArICdtdXN0IGJlIHNwZWNpZmllZCBpbiB0aGlzIG9wZXJhdGlvbidcbiAgICApO1xuICB9XG5cbiAgLy8gSWYgdGhlIGRldmljZSB0b2tlbiBpcyA2NCBjaGFyYWN0ZXJzIGxvbmcsIHdlIGFzc3VtZSBpdCBpcyBmb3IgaU9TXG4gIC8vIGFuZCBsb3dlcmNhc2UgaXQuXG4gIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiYgdGhpcy5kYXRhLmRldmljZVRva2VuLmxlbmd0aCA9PSA2NCkge1xuICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiA9IHRoaXMuZGF0YS5kZXZpY2VUb2tlbi50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgLy8gV2UgbG93ZXJjYXNlIHRoZSBpbnN0YWxsYXRpb25JZCBpZiBwcmVzZW50XG4gIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQudG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIGxldCBpbnN0YWxsYXRpb25JZCA9IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZDtcblxuICAvLyBJZiBkYXRhLmluc3RhbGxhdGlvbklkIGlzIG5vdCBzZXQgYW5kIHdlJ3JlIG5vdCBtYXN0ZXIsIHdlIGNhbiBsb29rdXAgaW4gYXV0aFxuICBpZiAoIWluc3RhbGxhdGlvbklkICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBpbnN0YWxsYXRpb25JZCA9IGluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBVcGRhdGluZyBfSW5zdGFsbGF0aW9uIGJ1dCBub3QgdXBkYXRpbmcgYW55dGhpbmcgY3JpdGljYWxcbiAgaWYgKHRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiAhaW5zdGFsbGF0aW9uSWQgJiYgIXRoaXMuZGF0YS5kZXZpY2VUeXBlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICB2YXIgaWRNYXRjaDsgLy8gV2lsbCBiZSBhIG1hdGNoIG9uIGVpdGhlciBvYmplY3RJZCBvciBpbnN0YWxsYXRpb25JZFxuICB2YXIgb2JqZWN0SWRNYXRjaDtcbiAgdmFyIGluc3RhbGxhdGlvbklkTWF0Y2g7XG4gIHZhciBkZXZpY2VUb2tlbk1hdGNoZXMgPSBbXTtcblxuICAvLyBJbnN0ZWFkIG9mIGlzc3VpbmcgMyByZWFkcywgbGV0J3MgZG8gaXQgd2l0aCBvbmUgT1IuXG4gIGNvbnN0IG9yUXVlcmllcyA9IFtdO1xuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goe1xuICAgICAgb2JqZWN0SWQ6IHRoaXMucXVlcnkub2JqZWN0SWQsXG4gICAgfSk7XG4gIH1cbiAgaWYgKGluc3RhbGxhdGlvbklkKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goe1xuICAgICAgaW5zdGFsbGF0aW9uSWQ6IGluc3RhbGxhdGlvbklkLFxuICAgIH0pO1xuICB9XG4gIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7IGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gfSk7XG4gIH1cblxuICBpZiAob3JRdWVyaWVzLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgcHJvbWlzZSA9IHByb21pc2VcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICAgJ19JbnN0YWxsYXRpb24nLFxuICAgICAgICB7XG4gICAgICAgICAgJG9yOiBvclF1ZXJpZXMsXG4gICAgICAgIH0sXG4gICAgICAgIHt9XG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICByZXN1bHRzLmZvckVhY2gocmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCAmJiByZXN1bHQub2JqZWN0SWQgPT0gdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICAgIG9iamVjdElkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5pbnN0YWxsYXRpb25JZCA9PSBpbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIGluc3RhbGxhdGlvbklkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5kZXZpY2VUb2tlbiA9PSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgLy8gU2FuaXR5IGNoZWNrcyB3aGVuIHJ1bm5pbmcgYSBxdWVyeVxuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICBpZiAoIW9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQgZm9yIHVwZGF0ZS4nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAhPT0gb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM2LCAnaW5zdGFsbGF0aW9uSWQgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAhPT0gb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICAhb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM2LCAnZGV2aWNlVG9rZW4gbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICE9PSBvYmplY3RJZE1hdGNoLmRldmljZVR5cGVcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDEzNiwgJ2RldmljZVR5cGUgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIG9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgaWRNYXRjaCA9IG9iamVjdElkTWF0Y2g7XG4gICAgICB9XG5cbiAgICAgIGlmIChpbnN0YWxsYXRpb25JZCAmJiBpbnN0YWxsYXRpb25JZE1hdGNoKSB7XG4gICAgICAgIGlkTWF0Y2ggPSBpbnN0YWxsYXRpb25JZE1hdGNoO1xuICAgICAgfVxuICAgICAgLy8gbmVlZCB0byBzcGVjaWZ5IGRldmljZVR5cGUgb25seSBpZiBpdCdzIG5ld1xuICAgICAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJiAhaWRNYXRjaCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM1LCAnZGV2aWNlVHlwZSBtdXN0IGJlIHNwZWNpZmllZCBpbiB0aGlzIG9wZXJhdGlvbicpO1xuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgaWYgKCFpZE1hdGNoKSB7XG4gICAgICAgIGlmICghZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoID09IDEgJiZcbiAgICAgICAgICAoIWRldmljZVRva2VuTWF0Y2hlc1swXVsnaW5zdGFsbGF0aW9uSWQnXSB8fCAhaW5zdGFsbGF0aW9uSWQpXG4gICAgICAgICkge1xuICAgICAgICAgIC8vIFNpbmdsZSBtYXRjaCBvbiBkZXZpY2UgdG9rZW4gYnV0IG5vbmUgb24gaW5zdGFsbGF0aW9uSWQsIGFuZCBlaXRoZXJcbiAgICAgICAgICAvLyB0aGUgcGFzc2VkIG9iamVjdCBvciB0aGUgbWF0Y2ggaXMgbWlzc2luZyBhbiBpbnN0YWxsYXRpb25JZCwgc28gd2VcbiAgICAgICAgICAvLyBjYW4ganVzdCByZXR1cm4gdGhlIG1hdGNoLlxuICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgIH0gZWxzZSBpZiAoIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIDEzMixcbiAgICAgICAgICAgICdNdXN0IHNwZWNpZnkgaW5zdGFsbGF0aW9uSWQgd2hlbiBkZXZpY2VUb2tlbiAnICtcbiAgICAgICAgICAgICAgJ21hdGNoZXMgbXVsdGlwbGUgSW5zdGFsbGF0aW9uIG9iamVjdHMnXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBNdWx0aXBsZSBkZXZpY2UgdG9rZW4gbWF0Y2hlcyBhbmQgd2Ugc3BlY2lmaWVkIGFuIGluc3RhbGxhdGlvbiBJRCxcbiAgICAgICAgICAvLyBvciBhIHNpbmdsZSBtYXRjaCB3aGVyZSBib3RoIHRoZSBwYXNzZWQgYW5kIG1hdGNoaW5nIG9iamVjdHMgaGF2ZVxuICAgICAgICAgIC8vIGFuIGluc3RhbGxhdGlvbiBJRC4gQ2xlYW4gb3V0IG90aGVyIGluc3RhbGxhdGlvbnMgdGhhdCBtYXRjaCB0aGVcbiAgICAgICAgICAvLyBkZXZpY2VUb2tlbiwgYW5kIHJldHVybiBuaWwgdG8gc2lnbmFsIHRoYXQgYSBuZXcgb2JqZWN0IHNob3VsZCBiZVxuICAgICAgICAgIC8vIGNyZWF0ZWQuXG4gICAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHtcbiAgICAgICAgICAgICAgJG5lOiBpbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfTtcbiAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgaW5zdGFsbGF0aW9uT3B0cyA9IHRoaXMuY29uZmlnLmluc3RhbGxhdGlvbiB8fCB7fTtcbiAgICAgICAgICByZXR1cm4gSW5zdGFsbGF0aW9uRGVkdXAucmVtb3ZlQ29uZmxpY3RpbmdEZXZpY2VUb2tlbih7XG4gICAgICAgICAgICBkYXRhYmFzZTogdGhpcy5jb25maWcuZGF0YWJhc2UsXG4gICAgICAgICAgICBxdWVyeTogZGVsUXVlcnksXG4gICAgICAgICAgICBhY3Rpb246IGluc3RhbGxhdGlvbk9wdHMuZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24gfHwgJ2RlbGV0ZScsXG4gICAgICAgICAgICBlbmZvcmNlQXV0aDogaW5zdGFsbGF0aW9uT3B0cy5kdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbkVuZm9yY2VBdXRoID09PSB0cnVlLFxuICAgICAgICAgICAgcnVuT3B0aW9uczogdGhpcy5ydW5PcHRpb25zLFxuICAgICAgICAgICAgdmFsaWRTY2hlbWFDb250cm9sbGVyOiB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKGRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGggPT0gMSAmJiAhZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydpbnN0YWxsYXRpb25JZCddKSB7XG4gICAgICAgICAgLy8gRXhhY3RseSBvbmUgZGV2aWNlIHRva2VuIG1hdGNoIGFuZCBpdCBkb2Vzbid0IGhhdmUgYW4gaW5zdGFsbGF0aW9uXG4gICAgICAgICAgLy8gSUQuIFRoZSB0d28gcm93cyByZXByZXNlbnQgdGhlIHNhbWUgaW5zdGFsbDsgcmVzb2x2ZSB0aGUgbWVyZ2UgcGVyXG4gICAgICAgICAgLy8gdGhlIGNvbmZpZ3VyZWQgb3B0aW9ucy5cbiAgICAgICAgICBjb25zdCBpbnN0YWxsYXRpb25PcHRzID0gdGhpcy5jb25maWcuaW5zdGFsbGF0aW9uIHx8IHt9O1xuICAgICAgICAgIHJldHVybiBJbnN0YWxsYXRpb25EZWR1cC5hcHBseUR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2Uoe1xuICAgICAgICAgICAgZGF0YWJhc2U6IHRoaXMuY29uZmlnLmRhdGFiYXNlLFxuICAgICAgICAgICAgaWRNYXRjaCxcbiAgICAgICAgICAgIGRldmljZVRva2VuTWF0Y2g6IGRldmljZVRva2VuTWF0Y2hlc1swXSxcbiAgICAgICAgICAgIGFjdGlvbjogaW5zdGFsbGF0aW9uT3B0cy5kdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbiB8fCAnZGVsZXRlJyxcbiAgICAgICAgICAgIG1lcmdlUHJpb3JpdHk6IGluc3RhbGxhdGlvbk9wdHMuZHVwbGljYXRlRGV2aWNlVG9rZW5NZXJnZVByaW9yaXR5IHx8ICdkZXZpY2VUb2tlbicsXG4gICAgICAgICAgICBlbmZvcmNlQXV0aDogaW5zdGFsbGF0aW9uT3B0cy5kdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbkVuZm9yY2VBdXRoID09PSB0cnVlLFxuICAgICAgICAgICAgcnVuT3B0aW9uczogdGhpcy5ydW5PcHRpb25zLFxuICAgICAgICAgICAgdmFsaWRTY2hlbWFDb250cm9sbGVyOiB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuICYmIGlkTWF0Y2guZGV2aWNlVG9rZW4gIT0gdGhpcy5kYXRhLmRldmljZVRva2VuKSB7XG4gICAgICAgICAgICAvLyBXZSdyZSBzZXR0aW5nIHRoZSBkZXZpY2UgdG9rZW4gb24gYW4gZXhpc3RpbmcgaW5zdGFsbGF0aW9uLCBzb1xuICAgICAgICAgICAgLy8gd2Ugc2hvdWxkIHRyeSBjbGVhbmluZyBvdXQgb2xkIGluc3RhbGxhdGlvbnMgdGhhdCBtYXRjaCB0aGlzXG4gICAgICAgICAgICAvLyBkZXZpY2UgdG9rZW4uXG4gICAgICAgICAgICBjb25zdCBkZWxRdWVyeSA9IHtcbiAgICAgICAgICAgICAgZGV2aWNlVG9rZW46IHRoaXMuZGF0YS5kZXZpY2VUb2tlbixcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICAvLyBXZSBoYXZlIGEgdW5pcXVlIGluc3RhbGwgSWQsIHVzZSB0aGF0IHRvIHByZXNlcnZlXG4gICAgICAgICAgICAvLyB0aGUgaW50ZXJlc3RpbmcgaW5zdGFsbGF0aW9uXG4gICAgICAgICAgICBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydpbnN0YWxsYXRpb25JZCddID0ge1xuICAgICAgICAgICAgICAgICRuZTogdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkLFxuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICAgICAgaWRNYXRjaC5vYmplY3RJZCAmJlxuICAgICAgICAgICAgICB0aGlzLmRhdGEub2JqZWN0SWQgJiZcbiAgICAgICAgICAgICAgaWRNYXRjaC5vYmplY3RJZCA9PSB0aGlzLmRhdGEub2JqZWN0SWRcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAvLyB3ZSBwYXNzZWQgYW4gb2JqZWN0SWQsIHByZXNlcnZlIHRoYXQgaW5zdGFsYXRpb25cbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ29iamVjdElkJ10gPSB7XG4gICAgICAgICAgICAgICAgJG5lOiBpZE1hdGNoLm9iamVjdElkLFxuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgLy8gV2hhdCB0byBkbyBoZXJlPyBjYW4ndCByZWFsbHkgY2xlYW4gdXAgZXZlcnl0aGluZy4uLlxuICAgICAgICAgICAgICByZXR1cm4gaWRNYXRjaC5vYmplY3RJZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0aGlzLmRhdGEuYXBwSWRlbnRpZmllcikge1xuICAgICAgICAgICAgICBkZWxRdWVyeVsnYXBwSWRlbnRpZmllciddID0gdGhpcy5kYXRhLmFwcElkZW50aWZpZXI7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBpbnN0YWxsYXRpb25PcHRzID0gdGhpcy5jb25maWcuaW5zdGFsbGF0aW9uIHx8IHt9O1xuICAgICAgICAgICAgcmV0dXJuIEluc3RhbGxhdGlvbkRlZHVwLnJlbW92ZUNvbmZsaWN0aW5nRGV2aWNlVG9rZW4oe1xuICAgICAgICAgICAgICBkYXRhYmFzZTogdGhpcy5jb25maWcuZGF0YWJhc2UsXG4gICAgICAgICAgICAgIHF1ZXJ5OiBkZWxRdWVyeSxcbiAgICAgICAgICAgICAgYWN0aW9uOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uIHx8ICdkZWxldGUnLFxuICAgICAgICAgICAgICBlbmZvcmNlQXV0aDogaW5zdGFsbGF0aW9uT3B0cy5kdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbkVuZm9yY2VBdXRoID09PSB0cnVlLFxuICAgICAgICAgICAgICBydW5PcHRpb25zOiB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgICAgIHZhbGlkU2NoZW1hQ29udHJvbGxlcjogdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICB9KS50aGVuKCgpID0+IGlkTWF0Y2gub2JqZWN0SWQpO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBJbiBub24tbWVyZ2Ugc2NlbmFyaW9zLCBqdXN0IHJldHVybiB0aGUgaW5zdGFsbGF0aW9uIG1hdGNoIGlkXG4gICAgICAgICAgcmV0dXJuIGlkTWF0Y2gub2JqZWN0SWQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KVxuICAgIC50aGVuKG9iaklkID0+IHtcbiAgICAgIGlmIChvYmpJZCkge1xuICAgICAgICB0aGlzLnF1ZXJ5ID0geyBvYmplY3RJZDogb2JqSWQgfTtcbiAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG4gICAgICB9XG4gICAgICAvLyBUT0RPOiBWYWxpZGF0ZSBvcHMgKGFkZC9yZW1vdmUgb24gY2hhbm5lbHMsICRpbmMgb24gYmFkZ2UsIGV0Yy4pXG4gICAgfSk7XG4gIHJldHVybiBwcm9taXNlO1xufTtcblxuLy8gSWYgd2Ugc2hvcnQtY2lyY3VpdGVkIHRoZSBvYmplY3QgcmVzcG9uc2UgLSB0aGVuIHdlIG5lZWQgdG8gbWFrZSBzdXJlIHdlIGV4cGFuZCBhbGwgdGhlIGZpbGVzLFxuLy8gc2luY2UgdGhpcyBtaWdodCBub3QgaGF2ZSBhIHF1ZXJ5LCBtZWFuaW5nIGl0IHdvbid0IHJldHVybiB0aGUgZnVsbCByZXN1bHQgYmFjay5cbi8vIFRPRE86IChubHV0c2Vua28pIFRoaXMgc2hvdWxkIGRpZSB3aGVuIHdlIG1vdmUgdG8gcGVyLWNsYXNzIGJhc2VkIGNvbnRyb2xsZXJzIG9uIF9TZXNzaW9uL19Vc2VyXG5SZXN0V3JpdGUucHJvdG90eXBlLmV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICAvLyBDaGVjayB3aGV0aGVyIHdlIGhhdmUgYSBzaG9ydC1jaXJjdWl0ZWQgcmVzcG9uc2UgLSBvbmx5IHRoZW4gcnVuIGV4cGFuc2lvbi5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIGF3YWl0IHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHRoaXMuY29uZmlnLCB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5EYXRhYmFzZU9wZXJhdGlvbiA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfUm9sZScpIHtcbiAgICBpZiAodGhpcy5kYXRhICYmIHRoaXMuZGF0YS51c2VycyAmJiB0aGlzLmRhdGEudXNlcnMub2JqZWN0cykge1xuICAgICAgdGhpcy5kYXRhLnVzZXJzLm9iamVjdHMuZm9yRWFjaCgoeyBvYmplY3RJZCB9KSA9PiB0aGlzLmNvbmZpZy5jYWNoZUNvbnRyb2xsZXIucm9sZS5kZWwob2JqZWN0SWQpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnJvbGUuY2xlYXIoKTtcbiAgICAgIGlmICh0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyKSB7XG4gICAgICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIuY2xlYXJDYWNoZWRSb2xlcyh0aGlzLmF1dGgudXNlcik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmIHRoaXMucXVlcnkgJiYgdGhpcy5hdXRoLmlzVW5hdXRoZW50aWNhdGVkKCkpIHtcbiAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLlNFU1NJT05fTUlTU0lORyxcbiAgICAgIGBDYW5ub3QgbW9kaWZ5IHVzZXIgJHt0aGlzLnF1ZXJ5Lm9iamVjdElkfS5gLFxuICAgICAgdGhpcy5jb25maWdcbiAgICApO1xuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1Byb2R1Y3QnICYmIHRoaXMuZGF0YS5kb3dubG9hZCkge1xuICAgIHRoaXMuZGF0YS5kb3dubG9hZE5hbWUgPSB0aGlzLmRhdGEuZG93bmxvYWQubmFtZTtcbiAgfVxuXG4gIC8vIFRPRE86IEFkZCBiZXR0ZXIgZGV0ZWN0aW9uIGZvciBBQ0wsIGVuc3VyaW5nIGEgdXNlciBjYW4ndCBiZSBsb2NrZWQgZnJvbVxuICAvLyAgICAgICB0aGVpciBvd24gdXNlciByZWNvcmQuXG4gIGlmICh0aGlzLmRhdGEuQUNMICYmIHRoaXMuZGF0YS5BQ0xbJyp1bnJlc29sdmVkJ10pIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9BQ0wsICdJbnZhbGlkIEFDTC4nKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgLy8gRm9yY2UgdGhlIHVzZXIgdG8gbm90IGxvY2tvdXRcbiAgICAvLyBNYXRjaGVkIHdpdGggcGFyc2UuY29tXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5BQ0wgJiZcbiAgICAgIHRoaXMuYXV0aC5pc01hc3RlciAhPT0gdHJ1ZSAmJlxuICAgICAgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UgIT09IHRydWVcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5BQ0xbdGhpcy5xdWVyeS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgfVxuICAgIC8vIHVwZGF0ZSBwYXNzd29yZCB0aW1lc3RhbXAgaWYgdXNlciBwYXNzd29yZCBpcyBiZWluZyBjaGFuZ2VkXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2VcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSk7XG4gICAgfVxuICAgIC8vIElnbm9yZSBjcmVhdGVkQXQgd2hlbiB1cGRhdGVcbiAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcblxuICAgIGxldCBkZWZlciA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIC8vIGlmIHBhc3N3b3JkIGhpc3RvcnkgaXMgZW5hYmxlZCB0aGVuIHNhdmUgdGhlIGN1cnJlbnQgcGFzc3dvcmQgdG8gaGlzdG9yeVxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeVxuICAgICkge1xuICAgICAgZGVmZXIgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAuZmluZChcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICAgIHsga2V5czogWydfcGFzc3dvcmRfaGlzdG9yeScsICdfaGFzaGVkX3Bhc3N3b3JkJ10gfSxcbiAgICAgICAgICBBdXRoLm1haW50ZW5hbmNlKHRoaXMuY29uZmlnKVxuICAgICAgICApXG4gICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICAgIGxldCBvbGRQYXNzd29yZHMgPSBbXTtcbiAgICAgICAgICBpZiAodXNlci5fcGFzc3dvcmRfaGlzdG9yeSkge1xuICAgICAgICAgICAgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgICAgICB1c2VyLl9wYXNzd29yZF9oaXN0b3J5LFxuICAgICAgICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnlcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vbi0xIHBhc3N3b3JkcyBnbyBpbnRvIGhpc3RvcnkgaW5jbHVkaW5nIGxhc3QgcGFzc3dvcmRcbiAgICAgICAgICB3aGlsZSAoXG4gICAgICAgICAgICBvbGRQYXNzd29yZHMubGVuZ3RoID4gTWF0aC5tYXgoMCwgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5IC0gMilcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIG9sZFBhc3N3b3Jkcy5zaGlmdCgpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvbGRQYXNzd29yZHMucHVzaCh1c2VyLnBhc3N3b3JkKTtcbiAgICAgICAgICB0aGlzLmRhdGEuX3Bhc3N3b3JkX2hpc3RvcnkgPSBvbGRQYXNzd29yZHM7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBkZWZlci50aGVuKCgpID0+IHtcbiAgICAgIC8vIFJ1biBhbiB1cGRhdGVcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAudXBkYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgICAgICApXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgdGhpcy5fdGhyb3dJZkF1dGhEYXRhRHVwbGljYXRlKGVycm9yKTtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgICAgIHJlc3BvbnNlLnVwZGF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEocmVzcG9uc2UsIHRoaXMuZGF0YSk7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZSA9IHsgcmVzcG9uc2UgfTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgLy8gU2V0IHRoZSBkZWZhdWx0IEFDTCBhbmQgcGFzc3dvcmQgdGltZXN0YW1wIGZvciB0aGUgbmV3IF9Vc2VyXG4gICAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICB2YXIgQUNMID0gdGhpcy5kYXRhLkFDTDtcbiAgICAgIC8vIGRlZmF1bHQgcHVibGljIHIvdyBBQ0xcbiAgICAgIGlmICghQUNMKSB7XG4gICAgICAgIEFDTCA9IHt9O1xuICAgICAgICBpZiAoIXRoaXMuY29uZmlnLmVuZm9yY2VQcml2YXRlVXNlcnMpIHtcbiAgICAgICAgICBBQ0xbJyonXSA9IHsgcmVhZDogdHJ1ZSwgd3JpdGU6IGZhbHNlIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIG1ha2Ugc3VyZSB0aGUgdXNlciBpcyBub3QgbG9ja2VkIGRvd25cbiAgICAgIEFDTFt0aGlzLmRhdGEub2JqZWN0SWRdID0geyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9O1xuICAgICAgdGhpcy5kYXRhLkFDTCA9IEFDTDtcbiAgICAgIC8vIHBhc3N3b3JkIHRpbWVzdGFtcCB0byBiZSB1c2VkIHdoZW4gcGFzc3dvcmQgZXhwaXJ5IHBvbGljeSBpcyBlbmZvcmNlZFxuICAgICAgaWYgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlKSB7XG4gICAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUnVuIGEgY3JlYXRlXG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuY3JlYXRlKHRoaXMuY2xhc3NOYW1lLCB0aGlzLmRhdGEsIHRoaXMucnVuT3B0aW9ucywgZmFsc2UsIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IGVycm9yLmNvZGUgIT09IFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSkge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5fdGhyb3dJZkF1dGhEYXRhRHVwbGljYXRlKGVycm9yKTtcblxuICAgICAgICAvLyBRdWljayBjaGVjaywgaWYgd2Ugd2VyZSBhYmxlIHRvIGluZmVyIHRoZSBkdXBsaWNhdGVkIGZpZWxkIG5hbWVcbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnVzZXJJbmZvICYmIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICd1c2VybmFtZScpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnVzZXJJbmZvICYmIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICdlbWFpbCcpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB0aGlzIHdhcyBhIGZhaWxlZCB1c2VyIGNyZWF0aW9uIGR1ZSB0byB1c2VybmFtZSBvciBlbWFpbCBhbHJlYWR5IHRha2VuLCB3ZSBuZWVkIHRvXG4gICAgICAgIC8vIGNoZWNrIHdoZXRoZXIgaXQgd2FzIHVzZXJuYW1lIG9yIGVtYWlsIGFuZCByZXR1cm4gdGhlIGFwcHJvcHJpYXRlIGVycm9yLlxuICAgICAgICAvLyBGYWxsYmFjayB0byB0aGUgb3JpZ2luYWwgbWV0aG9kXG4gICAgICAgIC8vIFRPRE86IFNlZSBpZiB3ZSBjYW4gbGF0ZXIgZG8gdGhpcyB3aXRob3V0IGFkZGl0aW9uYWwgcXVlcmllcyBieSB1c2luZyBuYW1lZCBpbmRleGVzLlxuICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAuZmluZChcbiAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB1c2VybmFtZTogdGhpcy5kYXRhLnVzZXJuYW1lLFxuICAgICAgICAgICAgICBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHsgbGltaXQ6IDEgfVxuICAgICAgICAgIClcbiAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOLFxuICAgICAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgeyBlbWFpbDogdGhpcy5kYXRhLmVtYWlsLCBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9IH0sXG4gICAgICAgICAgICAgIHsgbGltaXQ6IDEgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgcmVzcG9uc2Uub2JqZWN0SWQgPSB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gICAgICAgIHJlc3BvbnNlLmNyZWF0ZWRBdCA9IHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG5cbiAgICAgICAgaWYgKHRoaXMucmVzcG9uc2VTaG91bGRIYXZlVXNlcm5hbWUpIHtcbiAgICAgICAgICByZXNwb25zZS51c2VybmFtZSA9IHRoaXMuZGF0YS51c2VybmFtZTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKHJlc3BvbnNlLCB0aGlzLmRhdGEpO1xuICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICAgIHJlc3BvbnNlLFxuICAgICAgICAgIGxvY2F0aW9uOiB0aGlzLmxvY2F0aW9uKCksXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgfVxufTtcblxuLy8gUmV0dXJucyBub3RoaW5nIC0gZG9lc24ndCB3YWl0IGZvciB0aGUgdHJpZ2dlci5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQWZ0ZXJTYXZlVHJpZ2dlciA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLnJlc3BvbnNlIHx8ICF0aGlzLnJlc3BvbnNlLnJlc3BvbnNlIHx8IHRoaXMucnVuT3B0aW9ucy5tYW55KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYWZ0ZXJTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBjb25zdCBoYXNBZnRlclNhdmVIb29rID0gdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICApO1xuICBjb25zdCBoYXNMaXZlUXVlcnkgPSB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLmhhc0xpdmVRdWVyeSh0aGlzLmNsYXNzTmFtZSk7XG4gIGlmICghaGFzQWZ0ZXJTYXZlSG9vayAmJiAhaGFzTGl2ZVF1ZXJ5KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICB1cGRhdGVkT2JqZWN0Ll9oYW5kbGVTYXZlUmVzcG9uc2UodGhpcy5yZXNwb25zZS5yZXNwb25zZSwgdGhpcy5yZXNwb25zZS5zdGF0dXMgfHwgMjAwKTtcblxuICBpZiAoaGFzTGl2ZVF1ZXJ5KSB7XG4gICAgdGhpcy5jb25maWcuZGF0YWJhc2UubG9hZFNjaGVtYSgpLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICAvLyBOb3RpZnkgTGl2ZVF1ZXJ5U2VydmVyIGlmIHBvc3NpYmxlXG4gICAgICBjb25zdCBwZXJtcyA9IHNjaGVtYUNvbnRyb2xsZXIuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lKTtcbiAgICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIub25BZnRlclNhdmUoXG4gICAgICAgIHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgcGVybXNcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cbiAgaWYgKCFoYXNBZnRlclNhdmVIb29rKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFJ1biBhZnRlclNhdmUgdHJpZ2dlclxuICByZXR1cm4gdHJpZ2dlcnNcbiAgICAubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLFxuICAgICAgdGhpcy5hdXRoLFxuICAgICAgdXBkYXRlZE9iamVjdCxcbiAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLmNvbnRleHRcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgIGNvbnN0IGpzb25SZXR1cm5lZCA9IHJlc3VsdCAmJiAhcmVzdWx0Ll90b0Z1bGxKU09OO1xuICAgICAgaWYgKGpzb25SZXR1cm5lZCkge1xuICAgICAgICB0aGlzLnBlbmRpbmdPcHMub3BlcmF0aW9ucyA9IHt9O1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlID0gcmVzdWx0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZSA9IHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEoXG4gICAgICAgICAgKHJlc3VsdCB8fCB1cGRhdGVkT2JqZWN0KS50b0pTT04oKSxcbiAgICAgICAgICB0aGlzLmRhdGFcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBsb2dnZXIud2FybignYWZ0ZXJTYXZlIGNhdWdodCBhbiBlcnJvcicsIGVycik7XG4gICAgfSk7XG59O1xuXG4vLyBBIGhlbHBlciB0byBmaWd1cmUgb3V0IHdoYXQgbG9jYXRpb24gdGhpcyBvcGVyYXRpb24gaGFwcGVucyBhdC5cblJlc3RXcml0ZS5wcm90b3R5cGUubG9jYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBtaWRkbGUgPSB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyA/ICcvdXNlcnMvJyA6ICcvY2xhc3Nlcy8nICsgdGhpcy5jbGFzc05hbWUgKyAnLyc7XG4gIGNvbnN0IG1vdW50ID0gdGhpcy5jb25maWcubW91bnQgfHwgdGhpcy5jb25maWcuc2VydmVyVVJMO1xuICByZXR1cm4gbW91bnQgKyBtaWRkbGUgKyB0aGlzLmRhdGEub2JqZWN0SWQ7XG59O1xuXG4vLyBBIGhlbHBlciB0byBnZXQgdGhlIG9iamVjdCBpZCBmb3IgdGhpcyBvcGVyYXRpb24uXG4vLyBCZWNhdXNlIGl0IGNvdWxkIGJlIGVpdGhlciBvbiB0aGUgcXVlcnkgb3Igb24gdGhlIGRhdGFcblJlc3RXcml0ZS5wcm90b3R5cGUub2JqZWN0SWQgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLmRhdGEub2JqZWN0SWQgfHwgdGhpcy5xdWVyeS5vYmplY3RJZDtcbn07XG5cbi8vIFJldHVybnMgYSBjb3B5IG9mIHRoZSBkYXRhIGFuZCBkZWxldGUgYmFkIGtleXMgKF9hdXRoX2RhdGEsIF9oYXNoZWRfcGFzc3dvcmQuLi4pXG5SZXN0V3JpdGUucHJvdG90eXBlLnNhbml0aXplZERhdGEgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IGRhdGEgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLnJlZHVjZSgoZGF0YSwga2V5KSA9PiB7XG4gICAgLy8gUmVnZXhwIGNvbWVzIGZyb20gUGFyc2UuT2JqZWN0LnByb3RvdHlwZS52YWxpZGF0ZVxuICAgIGlmICghL15bQS1aYS16XVswLTlBLVphLXpfXSokLy50ZXN0KGtleSkpIHtcbiAgICAgIGRlbGV0ZSBkYXRhW2tleV07XG4gICAgfVxuICAgIHJldHVybiBkYXRhO1xuICB9LCBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5kYXRhKSk7XG4gIHJldHVybiBQYXJzZS5fZGVjb2RlKHVuZGVmaW5lZCwgZGF0YSk7XG59O1xuXG4vLyBSZXR1cm5zIGFuIHVwZGF0ZWQgY29weSBvZiB0aGUgb2JqZWN0XG5SZXN0V3JpdGUucHJvdG90eXBlLmJ1aWxkUGFyc2VPYmplY3RzID0gZnVuY3Rpb24gKCkge1xuICBjb25zdCBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUsIG9iamVjdElkOiB0aGlzLnF1ZXJ5Py5vYmplY3RJZCB9O1xuICBsZXQgb3JpZ2luYWxPYmplY3Q7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvcmlnaW5hbE9iamVjdCA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIH1cblxuICBjb25zdCBjbGFzc05hbWUgPSBQYXJzZS5PYmplY3QuZnJvbUpTT04oZXh0cmFEYXRhKTtcbiAgY29uc3QgcmVhZE9ubHlBdHRyaWJ1dGVzID0gY2xhc3NOYW1lLmNvbnN0cnVjdG9yLnJlYWRPbmx5QXR0cmlidXRlc1xuICAgID8gY2xhc3NOYW1lLmNvbnN0cnVjdG9yLnJlYWRPbmx5QXR0cmlidXRlcygpXG4gICAgOiBbXTtcblxuICAvLyBGb3IgX1JvbGUgY2xhc3MsICduYW1lJyBjYW5ub3QgYmUgc2V0IGFmdGVyIHRoZSByb2xlIGhhcyBhbiBvYmplY3RJZC5cbiAgLy8gSW4gYWZ0ZXJTYXZlIGNvbnRleHQsIF9oYW5kbGVTYXZlUmVzcG9uc2UgaGFzIGFscmVhZHkgc2V0IHRoZSBvYmplY3RJZCxcbiAgLy8gc28gd2UgdHJlYXQgJ25hbWUnIGFzIHJlYWQtb25seSB0byBhdm9pZCBQYXJzZSBTREsgdmFsaWRhdGlvbiBlcnJvcnMuXG4gIGNvbnN0IGlzUm9sZUFmdGVyU2F2ZSA9IHRoaXMuY2xhc3NOYW1lID09PSAnX1JvbGUnICYmIHRoaXMucmVzcG9uc2UgJiYgIXRoaXMucXVlcnk7XG4gIGlmIChpc1JvbGVBZnRlclNhdmUgJiYgdGhpcy5kYXRhLm5hbWUgJiYgIXJlYWRPbmx5QXR0cmlidXRlcy5pbmNsdWRlcygnbmFtZScpKSB7XG4gICAgcmVhZE9ubHlBdHRyaWJ1dGVzLnB1c2goJ25hbWUnKTtcbiAgfVxuICBpZiAoIXRoaXMub3JpZ2luYWxEYXRhKSB7XG4gICAgZm9yIChjb25zdCBhdHRyaWJ1dGUgb2YgcmVhZE9ubHlBdHRyaWJ1dGVzKSB7XG4gICAgICBleHRyYURhdGFbYXR0cmlidXRlXSA9IHRoaXMuZGF0YVthdHRyaWJ1dGVdO1xuICAgIH1cbiAgfVxuICBjb25zdCB1cGRhdGVkT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgT2JqZWN0LmtleXModGhpcy5kYXRhKS5yZWR1Y2UoZnVuY3Rpb24gKGRhdGEsIGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgaWYgKHR5cGVvZiBkYXRhW2tleV0uX19vcCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKCFyZWFkT25seUF0dHJpYnV0ZXMuaW5jbHVkZXMoa2V5KSkge1xuICAgICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KGtleSwgZGF0YVtrZXldKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gc3ViZG9jdW1lbnQga2V5IHdpdGggZG90IG5vdGF0aW9uIHsgJ3gueSc6IHYgfSA9PiB7ICd4JzogeyAneScgOiB2IH0gfSlcbiAgICAgICAgY29uc3Qgc3BsaXR0ZWRLZXkgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgICAgY29uc3QgcGFyZW50UHJvcCA9IHNwbGl0dGVkS2V5WzBdO1xuICAgICAgICBsZXQgcGFyZW50VmFsID0gdXBkYXRlZE9iamVjdC5nZXQocGFyZW50UHJvcCk7XG4gICAgICAgIGlmICh0eXBlb2YgcGFyZW50VmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICAgIHBhcmVudFZhbCA9IHt9O1xuICAgICAgICB9XG4gICAgICAgIHBhcmVudFZhbFtzcGxpdHRlZEtleVsxXV0gPSBkYXRhW2tleV07XG4gICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KHBhcmVudFByb3AsIHBhcmVudFZhbCk7XG4gICAgICB9XG4gICAgICBkZWxldGUgZGF0YVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfSwgc3RydWN0dXJlZENsb25lKHRoaXMuZGF0YSkpO1xuXG4gIGNvbnN0IHNhbml0aXplZCA9IHRoaXMuc2FuaXRpemVkRGF0YSgpO1xuICBmb3IgKGNvbnN0IGF0dHJpYnV0ZSBvZiByZWFkT25seUF0dHJpYnV0ZXMpIHtcbiAgICBkZWxldGUgc2FuaXRpemVkW2F0dHJpYnV0ZV07XG4gIH1cbiAgdXBkYXRlZE9iamVjdC5zZXQoc2FuaXRpemVkKTtcbiAgcmV0dXJuIHsgdXBkYXRlZE9iamVjdCwgb3JpZ2luYWxPYmplY3QgfTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY2xlYW5Vc2VyQXV0aERhdGEgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICBjb25zdCB1c2VyID0gdGhpcy5yZXNwb25zZS5yZXNwb25zZTtcbiAgICBpZiAodXNlci5hdXRoRGF0YSkge1xuICAgICAgT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgIGlmICh1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBpZiAoT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkubGVuZ3RoID09IDApIHtcbiAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGE7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG4vLyBTdHJpcHMgcHJvdGVjdGVkIGZpZWxkcyBmcm9tIHRoZSB3cml0ZSByZXNwb25zZSB3aGVuIHByb3RlY3RlZEZpZWxkc1NhdmVSZXNwb25zZUV4ZW1wdCBpcyBmYWxzZS5cblJlc3RXcml0ZS5wcm90b3R5cGUuZmlsdGVyUHJvdGVjdGVkRmllbGRzSW5SZXNwb25zZSA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY29uZmlnLnByb3RlY3RlZEZpZWxkc1NhdmVSZXNwb25zZUV4ZW1wdCAhPT0gZmFsc2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXRoaXMucmVzcG9uc2UgfHwgIXRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgc2NoZW1hQ29udHJvbGxlciA9IGF3YWl0IHRoaXMuY29uZmlnLmRhdGFiYXNlLmxvYWRTY2hlbWEoKTtcbiAgY29uc3QgcHJvdGVjdGVkRmllbGRzID0gdGhpcy5jb25maWcuZGF0YWJhc2UuYWRkUHJvdGVjdGVkRmllbGRzKFxuICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdGhpcy5xdWVyeSA/IHsgb2JqZWN0SWQ6IHRoaXMucXVlcnkub2JqZWN0SWQgfSA6IHt9LFxuICAgIHRoaXMuYXV0aC51c2VyID8gW3RoaXMuYXV0aC51c2VyLmlkXS5jb25jYXQodGhpcy5hdXRoLnVzZXJSb2xlcyB8fCBbXSkgOiBbXSxcbiAgICB0aGlzLmF1dGgsXG4gICAge31cbiAgKTtcbiAgaWYgKCFwcm90ZWN0ZWRGaWVsZHMpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBmaWVsZCBvZiBwcm90ZWN0ZWRGaWVsZHMpIHtcbiAgICBkZWxldGUgdGhpcy5yZXNwb25zZS5yZXNwb25zZVtmaWVsZF07XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEgPSBmdW5jdGlvbiAocmVzcG9uc2UsIGRhdGEpIHtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKHRoaXMucGVuZGluZ09wcy5pZGVudGlmaWVyKTtcbiAgZm9yIChjb25zdCBrZXkgaW4gdGhpcy5wZW5kaW5nT3BzLm9wZXJhdGlvbnMpIHtcbiAgICBpZiAoIXBlbmRpbmdba2V5XSkge1xuICAgICAgZGF0YVtrZXldID0gdGhpcy5vcmlnaW5hbERhdGEgPyB0aGlzLm9yaWdpbmFsRGF0YVtrZXldIDogeyBfX29wOiAnRGVsZXRlJyB9O1xuICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIucHVzaChrZXkpO1xuICAgIH1cbiAgfVxuICBjb25zdCBza2lwS2V5cyA9IFsuLi4ocmVxdWlyZWRDb2x1bW5zLnJlYWRbdGhpcy5jbGFzc05hbWVdIHx8IFtdKV07XG4gIGlmICghdGhpcy5xdWVyeSkge1xuICAgIHNraXBLZXlzLnB1c2goJ29iamVjdElkJywgJ2NyZWF0ZWRBdCcpO1xuICB9IGVsc2Uge1xuICAgIHNraXBLZXlzLnB1c2goJ3VwZGF0ZWRBdCcpO1xuICAgIGRlbGV0ZSByZXNwb25zZS5vYmplY3RJZDtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBpbiByZXNwb25zZSkge1xuICAgIGlmIChza2lwS2V5cy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgdmFsdWUgPSByZXNwb25zZVtrZXldO1xuICAgIGlmIChcbiAgICAgIHZhbHVlID09IG51bGwgfHxcbiAgICAgICh2YWx1ZS5fX3R5cGUgJiYgdmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKGRhdGFba2V5XSwgdmFsdWUpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKCh0aGlzLm9yaWdpbmFsRGF0YSB8fCB7fSlba2V5XSwgdmFsdWUpXG4gICAgKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2Vba2V5XTtcbiAgICB9XG4gIH1cbiAgaWYgKF8uaXNFbXB0eSh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlcikpIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgY2xpZW50U3VwcG9ydHNEZWxldGUgPSBDbGllbnRTREsuc3VwcG9ydHNGb3J3YXJkRGVsZXRlKHRoaXMuY2xpZW50U0RLKTtcbiAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGNvbnN0IGRhdGFWYWx1ZSA9IGRhdGFbZmllbGROYW1lXTtcblxuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3BvbnNlLCBmaWVsZE5hbWUpKSB7XG4gICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgIH1cblxuICAgIC8vIFN0cmlwcyBvcGVyYXRpb25zIGZyb20gcmVzcG9uc2VzXG4gICAgaWYgKHJlc3BvbnNlW2ZpZWxkTmFtZV0gJiYgcmVzcG9uc2VbZmllbGROYW1lXS5fX29wKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2VbZmllbGROYW1lXTtcbiAgICAgIGlmIChjbGllbnRTdXBwb3J0c0RlbGV0ZSAmJiBkYXRhVmFsdWUuX19vcCA9PSAnRGVsZXRlJykge1xuICAgICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiByZXNwb25zZTtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IFJlc3RXcml0ZTtcbm1vZHVsZS5leHBvcnRzID0gUmVzdFdyaXRlO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFjQSxJQUFBQSxVQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRSxPQUFBLEdBQUFILHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRyxpQkFBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksTUFBQSxHQUFBSixPQUFBO0FBQ0EsSUFBQUssYUFBQSxHQUFBTCxPQUFBO0FBQ0EsSUFBQU0saUJBQUEsR0FBQUMsdUJBQUEsQ0FBQVAsT0FBQTtBQUF5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