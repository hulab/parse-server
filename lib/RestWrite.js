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
function RestWrite(config, auth, className, query, data, originalData, context, action) {
  if (auth.isReadOnly) {
    throw (0, _Error.createSanitizedError)(Parse.Error.OPERATION_FORBIDDEN, 'Cannot perform a write operation when using readOnlyMasterKey', config);
  }
  this.config = config;
  this.auth = auth;
  this.className = className;
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
      }) => {
        this.config.cacheController.role.del(objectId);
        if (this.config.liveQueryController) {
          this.config.liveQueryController.clearCachedRoles(Parse.User.createWithoutData(objectId));
        }
      });
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
  this.storage.fieldsChangedByTrigger.forEach(fieldName => {
    const dataValue = data[fieldName];
    if (!Object.prototype.hasOwnProperty.call(response, fieldName)) {
      response[fieldName] = dataValue;
    }
    if (response[fieldName] && response[fieldName].__op) {
      delete response[fieldName];
      if (dataValue.__op == 'Delete') {
        response[fieldName] = dataValue;
      }
    }
  });
  return response;
};
var _default = exports.default = RestWrite;
module.exports = RestWrite;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUmVzdFF1ZXJ5IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9TY2hlbWFDb250cm9sbGVyIiwiX0Vycm9yIiwiX0F1dGhEYXRhTG9jayIsIkluc3RhbGxhdGlvbkRlZHVwIiwiX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQiLCJlIiwidCIsIldlYWtNYXAiLCJyIiwibiIsIl9fZXNNb2R1bGUiLCJvIiwiaSIsImYiLCJfX3Byb3RvX18iLCJkZWZhdWx0IiwiaGFzIiwiZ2V0Iiwic2V0IiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiT2JqZWN0IiwiZGVmaW5lUHJvcGVydHkiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IiLCJTY2hlbWFDb250cm9sbGVyIiwiQXV0aCIsIlV0aWxzIiwiY3J5cHRvVXRpbHMiLCJwYXNzd29yZENyeXB0byIsIlBhcnNlIiwidHJpZ2dlcnMiLCJ1dGlsIiwiUmVzdFdyaXRlIiwiY29uZmlnIiwiYXV0aCIsImNsYXNzTmFtZSIsInF1ZXJ5IiwiZGF0YSIsIm9yaWdpbmFsRGF0YSIsImNvbnRleHQiLCJhY3Rpb24iLCJpc1JlYWRPbmx5IiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJFcnJvciIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJzdG9yYWdlIiwicnVuT3B0aW9ucyIsImFsbG93Q3VzdG9tT2JqZWN0SWQiLCJwcm90b3R5cGUiLCJvYmplY3RJZCIsIk1JU1NJTkdfT0JKRUNUX0lEIiwiSU5WQUxJRF9LRVlfTkFNRSIsImlkIiwicmVzcG9uc2UiLCJzdHJ1Y3R1cmVkQ2xvbmUiLCJ1cGRhdGVkQXQiLCJfZW5jb2RlIiwiRGF0ZSIsImlzbyIsInZhbGlkU2NoZW1hQ29udHJvbGxlciIsInBlbmRpbmdPcHMiLCJvcGVyYXRpb25zIiwiaWRlbnRpZmllciIsImV4ZWN1dGUiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsImhhbmRsZUluc3RhbGxhdGlvbiIsImhhbmRsZVNlc3Npb24iLCJ2YWxpZGF0ZUF1dGhEYXRhIiwiY2hlY2tSZXN0cmljdGVkRmllbGRzIiwicnVuQmVmb3JlU2F2ZVRyaWdnZXIiLCJlbnN1cmVVbmlxdWVBdXRoRGF0YUlkIiwiZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQiLCJ2YWxpZGF0ZVNjaGVtYSIsInNjaGVtYUNvbnRyb2xsZXIiLCJzZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkIiwidmFsaWRhdGVDcmVhdGVQZXJtaXNzaW9uIiwidHJhbnNmb3JtVXNlciIsImV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzIiwiZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucyIsInJ1bkRhdGFiYXNlT3BlcmF0aW9uIiwiY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQiLCJoYW5kbGVGb2xsb3d1cCIsInJ1bkFmdGVyU2F2ZVRyaWdnZXIiLCJjbGVhblVzZXJBdXRoRGF0YSIsImZpbHRlclByb3RlY3RlZEZpZWxkc0luUmVzcG9uc2UiLCJhdXRoRGF0YVJlc3BvbnNlIiwicmVqZWN0U2lnbnVwIiwicHJldmVudFNpZ251cFdpdGhVbnZlcmlmaWVkRW1haWwiLCJFTUFJTF9OT1RfRk9VTkQiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJhY2wiLCJ1c2VyIiwiZ2V0VXNlclJvbGVzIiwicm9sZXMiLCJjb25jYXQiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwiaW5kZXhPZiIsImRhdGFiYXNlIiwibG9hZFNjaGVtYSIsImhhc0NsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJtYW55IiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYmVmb3JlU2F2ZSIsImFwcGxpY2F0aW9uSWQiLCJvcmlnaW5hbE9iamVjdCIsInVwZGF0ZWRPYmplY3QiLCJidWlsZFBhcnNlT2JqZWN0cyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJzdGF0ZUNvbnRyb2xsZXIiLCJDb3JlTWFuYWdlciIsImdldE9iamVjdFN0YXRlQ29udHJvbGxlciIsInBlbmRpbmciLCJnZXRQZW5kaW5nT3BzIiwiZGF0YWJhc2VQcm9taXNlIiwidXBkYXRlIiwiY3JlYXRlIiwicmVzdWx0IiwibGVuZ3RoIiwiT0JKRUNUX05PVF9GT1VORCIsIm1heWJlUnVuVHJpZ2dlciIsIm9iamVjdCIsImZpZWxkc0NoYW5nZWRCeVRyaWdnZXIiLCJfIiwicmVkdWNlIiwidmFsdWUiLCJrZXkiLCJpc0VxdWFsIiwicHVzaCIsImNoZWNrUHJvaGliaXRlZEtleXdvcmRzIiwiZXJyb3IiLCJydW5CZWZvcmVMb2dpblRyaWdnZXIiLCJ1c2VyRGF0YSIsImJlZm9yZUxvZ2luIiwiZXh0cmFEYXRhIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsImluZmxhdGUiLCJnZXRBbGxDbGFzc2VzIiwiYWxsQ2xhc3NlcyIsInNjaGVtYSIsImZpbmQiLCJvbmVDbGFzcyIsInNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCIsImZpZWxkTmFtZSIsInNldERlZmF1bHQiLCJ1bmRlZmluZWQiLCJfX29wIiwiZmllbGRzIiwiZGVmYXVsdFZhbHVlIiwicmVxdWlyZWQiLCJWQUxJREFUSU9OX0VSUk9SIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiQUNMIiwiSlNPTiIsInN0cmluZ2lmeSIsInJlYWQiLCJ3cml0ZSIsImN1cnJlbnRVc2VyIiwiY3JlYXRlZEF0IiwiX190eXBlIiwibmV3T2JqZWN0SWQiLCJvYmplY3RJZFNpemUiLCJrZXlzIiwiZm9yRWFjaCIsImF1dGhEYXRhIiwiaGFzVXNlcm5hbWVBbmRQYXNzd29yZCIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJoYXNBdXRoRGF0YSIsInNvbWUiLCJwcm92aWRlciIsInByb3ZpZGVyRGF0YSIsImlzRW1wdHkiLCJVU0VSTkFNRV9NSVNTSU5HIiwiUEFTU1dPUkRfTUlTU0lORyIsIlVOU1VQUE9SVEVEX1NFUlZJQ0UiLCJwcm92aWRlcnMiLCJjYW5IYW5kbGVBdXRoRGF0YSIsInByb3ZpZGVyQXV0aERhdGEiLCJnZXRVc2VySWQiLCJoYW5kbGVBdXRoRGF0YSIsImZpbHRlcmVkT2JqZWN0c0J5QUNMIiwib2JqZWN0cyIsImZpbHRlciIsIl90aHJvd0lmQXV0aERhdGFEdXBsaWNhdGUiLCJjb2RlIiwiRFVQTElDQVRFX1ZBTFVFIiwidXNlckluZm8iLCJkdXBsaWNhdGVkX2ZpZWxkIiwic3RhcnRzV2l0aCIsIkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQiLCJoYXNBdXRoRGF0YUlkIiwiZmluZFVzZXJzV2l0aEF1dGhEYXRhIiwicmVzdWx0cyIsInVzZXJJZCIsImN1cnJlbnRVc2VyQXV0aERhdGEiLCJ1c2VyUmVzdWx0IiwiZm91bmRVc2VySXNOb3RDdXJyZW50VXNlciIsImhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiIsInZhbGlkYXRlZEF1dGhEYXRhIiwiYXV0aFByb3ZpZGVyIiwiam9pbiIsImhhc011dGF0ZWRBdXRoRGF0YSIsIm11dGF0ZWRBdXRoRGF0YSIsImlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3RlciIsImlzTG9naW4iLCJsb2NhdGlvbiIsImNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4iLCJhbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuIiwicmVzIiwib3JpZ2luYWxBdXRoRGF0YSIsImZyb21FbnRyaWVzIiwiZW50cmllcyIsIm1hcCIsImsiLCJ2IiwiYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrIiwiU0NSSVBUX0ZBSUxFRCIsInZhbGlkYXRlUGVybWlzc2lvbiIsInByb21pc2UiLCJSZXN0UXVlcnkiLCJtZXRob2QiLCJNZXRob2QiLCJtYXN0ZXIiLCJydW5CZWZvcmVGaW5kIiwicmVzdFdoZXJlIiwic2Vzc2lvbiIsImNhY2hlQ29udHJvbGxlciIsImRlbCIsInNlc3Npb25Ub2tlbiIsIl92YWxpZGF0ZVBhc3N3b3JkUG9saWN5IiwiaGFzaCIsImhhc2hlZFBhc3N3b3JkIiwiX2hhc2hlZF9wYXNzd29yZCIsIl92YWxpZGF0ZVVzZXJOYW1lIiwiX3ZhbGlkYXRlRW1haWwiLCJyYW5kb21TdHJpbmciLCJyZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSIsIiRuZSIsImxpbWl0IiwiY2FzZUluc2Vuc2l0aXZlIiwiVVNFUk5BTUVfVEFLRU4iLCJidWlsZENyZWF0ZWRXaXRoIiwiZ2V0Q3JlYXRlZFdpdGgiLCJjcmVhdGVkV2l0aCIsImlzQ3JlYXRlT3BlcmF0aW9uIiwiYXV0aERhdGFQcm92aWRlciIsInJlc29sdmVkQXV0aFByb3ZpZGVyIiwiZW1haWwiLCJtYXRjaCIsInJlamVjdCIsIklOVkFMSURfRU1BSUxfQUREUkVTUyIsIkVNQUlMX1RBS0VOIiwicmVxdWVzdCIsIm9yaWdpbmFsIiwiaXAiLCJpbnN0YWxsYXRpb25JZCIsInVzZXJDb250cm9sbGVyIiwic2V0RW1haWxWZXJpZnlUb2tlbiIsInBhc3N3b3JkUG9saWN5IiwiX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMiLCJfdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkiLCJwb2xpY3lFcnJvciIsInZhbGlkYXRpb25FcnJvciIsImNvbnRhaW5zVXNlcm5hbWVFcnJvciIsInBhdHRlcm5WYWxpZGF0b3IiLCJ2YWxpZGF0b3JDYWxsYmFjayIsImRvTm90QWxsb3dVc2VybmFtZSIsIm1heFBhc3N3b3JkSGlzdG9yeSIsIm1haW50ZW5hbmNlIiwib2xkUGFzc3dvcmRzIiwiX3Bhc3N3b3JkX2hpc3RvcnkiLCJ0YWtlIiwibmV3UGFzc3dvcmQiLCJwcm9taXNlcyIsImNvbXBhcmUiLCJhbGwiLCJjYXRjaCIsImVyciIsInZlcmlmeVVzZXJFbWFpbHMiLCJwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsIiwiY3JlYXRlU2Vzc2lvblRva2VuIiwic2Vzc2lvbkRhdGEiLCJjcmVhdGVTZXNzaW9uIiwiYWRkaXRpb25hbFNlc3Npb25EYXRhIiwidG9rZW4iLCJuZXdUb2tlbiIsImV4cGlyZXNBdCIsImdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCIsImFzc2lnbiIsImFkZE9wcyIsIl9wZXJpc2hhYmxlX3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsImRlc3Ryb3kiLCJyZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0Iiwic2Vzc2lvblF1ZXJ5IiwiYmluZCIsInNlbmRWZXJpZmljYXRpb25FbWFpbCIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsIiRhbmQiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJzdGF0dXMiLCJkZXZpY2VUb2tlbiIsInRvTG93ZXJDYXNlIiwiZGV2aWNlVHlwZSIsImlkTWF0Y2giLCJvYmplY3RJZE1hdGNoIiwiaW5zdGFsbGF0aW9uSWRNYXRjaCIsImRldmljZVRva2VuTWF0Y2hlcyIsIm9yUXVlcmllcyIsIiRvciIsImRlbFF1ZXJ5IiwiYXBwSWRlbnRpZmllciIsImluc3RhbGxhdGlvbk9wdHMiLCJpbnN0YWxsYXRpb24iLCJyZW1vdmVDb25mbGljdGluZ0RldmljZVRva2VuIiwiZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24iLCJlbmZvcmNlQXV0aCIsImR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGgiLCJhcHBseUR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2UiLCJkZXZpY2VUb2tlbk1hdGNoIiwibWVyZ2VQcmlvcml0eSIsImR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2VQcmlvcml0eSIsIm9iaklkIiwidXNlcnMiLCJyb2xlIiwibGl2ZVF1ZXJ5Q29udHJvbGxlciIsImNsZWFyQ2FjaGVkUm9sZXMiLCJVc2VyIiwiY3JlYXRlV2l0aG91dERhdGEiLCJjbGVhciIsImlzVW5hdXRoZW50aWNhdGVkIiwiU0VTU0lPTl9NSVNTSU5HIiwiZG93bmxvYWQiLCJkb3dubG9hZE5hbWUiLCJuYW1lIiwiSU5WQUxJRF9BQ0wiLCJtYXhQYXNzd29yZEFnZSIsIl9wYXNzd29yZF9jaGFuZ2VkX2F0IiwiZGVmZXIiLCJNYXRoIiwibWF4Iiwic2hpZnQiLCJfdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSIsImVuZm9yY2VQcml2YXRlVXNlcnMiLCJoYXNBZnRlclNhdmVIb29rIiwiYWZ0ZXJTYXZlIiwiaGFzTGl2ZVF1ZXJ5IiwiX2hhbmRsZVNhdmVSZXNwb25zZSIsInBlcm1zIiwiZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zIiwib25BZnRlclNhdmUiLCJqc29uUmV0dXJuZWQiLCJfdG9GdWxsSlNPTiIsInRvSlNPTiIsImxvZ2dlciIsIndhcm4iLCJtaWRkbGUiLCJtb3VudCIsInNlcnZlclVSTCIsInNhbml0aXplZERhdGEiLCJ0ZXN0IiwiX2RlY29kZSIsImZyb21KU09OIiwicmVhZE9ubHlBdHRyaWJ1dGVzIiwiY29uc3RydWN0b3IiLCJpc1JvbGVBZnRlclNhdmUiLCJpbmNsdWRlcyIsImF0dHJpYnV0ZSIsInNwbGl0dGVkS2V5Iiwic3BsaXQiLCJwYXJlbnRQcm9wIiwicGFyZW50VmFsIiwic2FuaXRpemVkIiwicHJvdGVjdGVkRmllbGRzU2F2ZVJlc3BvbnNlRXhlbXB0IiwicHJvdGVjdGVkRmllbGRzIiwiYWRkUHJvdGVjdGVkRmllbGRzIiwidXNlclJvbGVzIiwiZmllbGQiLCJza2lwS2V5cyIsInJlcXVpcmVkQ29sdW1ucyIsImlzRGVlcFN0cmljdEVxdWFsIiwiZGF0YVZhbHVlIiwiX2RlZmF1bHQiLCJleHBvcnRzIiwibW9kdWxlIl0sInNvdXJjZXMiOlsiLi4vc3JjL1Jlc3RXcml0ZS5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBBIFJlc3RXcml0ZSBlbmNhcHN1bGF0ZXMgZXZlcnl0aGluZyB3ZSBuZWVkIHRvIHJ1biBhbiBvcGVyYXRpb25cbi8vIHRoYXQgd3JpdGVzIHRvIHRoZSBkYXRhYmFzZS5cbi8vIFRoaXMgY291bGQgYmUgZWl0aGVyIGEgXCJjcmVhdGVcIiBvciBhbiBcInVwZGF0ZVwiLlxuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xuXG5jb25zdCBBdXRoID0gcmVxdWlyZSgnLi9BdXRoJyk7XG5jb25zdCBVdGlscyA9IHJlcXVpcmUoJy4vVXRpbHMnKTtcbnZhciBjcnlwdG9VdGlscyA9IHJlcXVpcmUoJy4vY3J5cHRvVXRpbHMnKTtcbnZhciBwYXNzd29yZENyeXB0byA9IHJlcXVpcmUoJy4vcGFzc3dvcmQnKTtcbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKTtcbnZhciB0cmlnZ2VycyA9IHJlcXVpcmUoJy4vdHJpZ2dlcnMnKTtcbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5pbXBvcnQgUmVzdFF1ZXJ5IGZyb20gJy4vUmVzdFF1ZXJ5JztcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCB7IHJlcXVpcmVkQ29sdW1ucyB9IGZyb20gJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcic7XG5pbXBvcnQgeyBjcmVhdGVTYW5pdGl6ZWRFcnJvciB9IGZyb20gJy4vRXJyb3InO1xuaW1wb3J0IHsgYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrIH0gZnJvbSAnLi9BdXRoRGF0YUxvY2snO1xuaW1wb3J0ICogYXMgSW5zdGFsbGF0aW9uRGVkdXAgZnJvbSAnLi9JbnN0YWxsYXRpb25EZWR1cCc7XG5cbi8vIHF1ZXJ5IGFuZCBkYXRhIGFyZSBib3RoIHByb3ZpZGVkIGluIFJFU1QgQVBJIGZvcm1hdC4gU28gZGF0YVxuLy8gdHlwZXMgYXJlIGVuY29kZWQgYnkgcGxhaW4gb2xkIG9iamVjdHMuXG4vLyBJZiBxdWVyeSBpcyBudWxsLCB0aGlzIGlzIGEgXCJjcmVhdGVcIiBhbmQgdGhlIGRhdGEgaW4gZGF0YSBzaG91bGQgYmVcbi8vIGNyZWF0ZWQuXG4vLyBPdGhlcndpc2UgdGhpcyBpcyBhbiBcInVwZGF0ZVwiIC0gdGhlIG9iamVjdCBtYXRjaGluZyB0aGUgcXVlcnlcbi8vIHNob3VsZCBnZXQgdXBkYXRlZCB3aXRoIGRhdGEuXG4vLyBSZXN0V3JpdGUgd2lsbCBoYW5kbGUgb2JqZWN0SWQsIGNyZWF0ZWRBdCwgYW5kIHVwZGF0ZWRBdCBmb3Jcbi8vIGV2ZXJ5dGhpbmcuIEl0IGFsc28ga25vd3MgdG8gdXNlIHRyaWdnZXJzIGFuZCBzcGVjaWFsIG1vZGlmaWNhdGlvbnNcbi8vIGZvciB0aGUgX1VzZXIgY2xhc3MuXG5mdW5jdGlvbiBSZXN0V3JpdGUoY29uZmlnLCBhdXRoLCBjbGFzc05hbWUsIHF1ZXJ5LCBkYXRhLCBvcmlnaW5hbERhdGEsIGNvbnRleHQsIGFjdGlvbikge1xuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgJ0Nhbm5vdCBwZXJmb3JtIGEgd3JpdGUgb3BlcmF0aW9uIHdoZW4gdXNpbmcgcmVhZE9ubHlNYXN0ZXJLZXknLFxuICAgICAgY29uZmlnXG4gICAgKTtcbiAgfVxuICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgdGhpcy5hdXRoID0gYXV0aDtcbiAgdGhpcy5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gIHRoaXMuc3RvcmFnZSA9IHt9O1xuICB0aGlzLnJ1bk9wdGlvbnMgPSB7fTtcbiAgdGhpcy5jb250ZXh0ID0gY29udGV4dCB8fCB7fTtcblxuICBpZiAoYWN0aW9uKSB7XG4gICAgdGhpcy5ydW5PcHRpb25zLmFjdGlvbiA9IGFjdGlvbjtcbiAgfVxuXG4gIGlmICghcXVlcnkpIHtcbiAgICBpZiAodGhpcy5jb25maWcuYWxsb3dDdXN0b21PYmplY3RJZCkge1xuICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChkYXRhLCAnb2JqZWN0SWQnKSAmJiAhZGF0YS5vYmplY3RJZCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuTUlTU0lOR19PQkpFQ1RfSUQsXG4gICAgICAgICAgJ29iamVjdElkIG11c3Qgbm90IGJlIGVtcHR5LCBudWxsIG9yIHVuZGVmaW5lZCdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKGRhdGEub2JqZWN0SWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdvYmplY3RJZCBpcyBhbiBpbnZhbGlkIGZpZWxkIG5hbWUuJyk7XG4gICAgICB9XG4gICAgICBpZiAoZGF0YS5pZCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ2lkIGlzIGFuIGludmFsaWQgZmllbGQgbmFtZS4nKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBXaGVuIHRoZSBvcGVyYXRpb24gaXMgY29tcGxldGUsIHRoaXMucmVzcG9uc2UgbWF5IGhhdmUgc2V2ZXJhbFxuICAvLyBmaWVsZHMuXG4gIC8vIHJlc3BvbnNlOiB0aGUgYWN0dWFsIGRhdGEgdG8gYmUgcmV0dXJuZWRcbiAgLy8gc3RhdHVzOiB0aGUgaHR0cCBzdGF0dXMgY29kZS4gaWYgbm90IHByZXNlbnQsIHRyZWF0ZWQgbGlrZSBhIDIwMFxuICAvLyBsb2NhdGlvbjogdGhlIGxvY2F0aW9uIGhlYWRlci4gaWYgbm90IHByZXNlbnQsIG5vIGxvY2F0aW9uIGhlYWRlclxuICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcblxuICAvLyBQcm9jZXNzaW5nIHRoaXMgb3BlcmF0aW9uIG1heSBtdXRhdGUgb3VyIGRhdGEsIHNvIHdlIG9wZXJhdGUgb24gYVxuICAvLyBjb3B5XG4gIHRoaXMucXVlcnkgPSBzdHJ1Y3R1cmVkQ2xvbmUocXVlcnkpO1xuICB0aGlzLmRhdGEgPSBzdHJ1Y3R1cmVkQ2xvbmUoZGF0YSk7XG4gIC8vIFdlIG5ldmVyIGNoYW5nZSBvcmlnaW5hbERhdGEsIHNvIHdlIGRvIG5vdCBuZWVkIGEgZGVlcCBjb3B5XG4gIHRoaXMub3JpZ2luYWxEYXRhID0gb3JpZ2luYWxEYXRhO1xuXG4gIC8vIFRoZSB0aW1lc3RhbXAgd2UnbGwgdXNlIGZvciB0aGlzIHdob2xlIG9wZXJhdGlvblxuICB0aGlzLnVwZGF0ZWRBdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSkuaXNvO1xuXG4gIC8vIFNoYXJlZCBTY2hlbWFDb250cm9sbGVyIHRvIGJlIHJldXNlZCB0byByZWR1Y2UgdGhlIG51bWJlciBvZiBsb2FkU2NoZW1hKCkgY2FsbHMgcGVyIHJlcXVlc3RcbiAgLy8gT25jZSBzZXQgdGhlIHNjaGVtYURhdGEgc2hvdWxkIGJlIGltbXV0YWJsZVxuICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlciA9IG51bGw7XG4gIHRoaXMucGVuZGluZ09wcyA9IHtcbiAgICBvcGVyYXRpb25zOiBudWxsLFxuICAgIGlkZW50aWZpZXI6IG51bGwsXG4gIH07XG59XG5cbi8vIEEgY29udmVuaWVudCBtZXRob2QgdG8gcGVyZm9ybSBhbGwgdGhlIHN0ZXBzIG9mIHByb2Nlc3NpbmcgdGhlXG4vLyB3cml0ZSwgaW4gb3JkZXIuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSB7cmVzcG9uc2UsIHN0YXR1cywgbG9jYXRpb259IG9iamVjdC5cbi8vIHN0YXR1cyBhbmQgbG9jYXRpb24gYXJlIG9wdGlvbmFsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5nZXRVc2VyQW5kUm9sZUFDTCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVJbnN0YWxsYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZVNlc3Npb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQXV0aERhdGEoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNoZWNrUmVzdHJpY3RlZEZpZWxkcygpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuQmVmb3JlU2F2ZVRyaWdnZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmVuc3VyZVVuaXF1ZUF1dGhEYXRhSWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZVNjaGVtYSgpO1xuICAgIH0pXG4gICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlciA9IHNjaGVtYUNvbnRyb2xsZXI7XG4gICAgICByZXR1cm4gdGhpcy5zZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUNyZWF0ZVBlcm1pc3Npb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnRyYW5zZm9ybVVzZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5EYXRhYmFzZU9wZXJhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5BZnRlclNhdmVUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jbGVhblVzZXJBdXRoRGF0YSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZmlsdGVyUHJvdGVjdGVkRmllbGRzSW5SZXNwb25zZSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gQXBwZW5kIHRoZSBhdXRoRGF0YVJlc3BvbnNlIGlmIGV4aXN0c1xuICAgICAgaWYgKHRoaXMuYXV0aERhdGFSZXNwb25zZSkge1xuICAgICAgICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5hdXRoRGF0YVJlc3BvbnNlID0gdGhpcy5hdXRoRGF0YVJlc3BvbnNlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5zdG9yYWdlLnJlamVjdFNpZ251cCAmJiB0aGlzLmNvbmZpZy5wcmV2ZW50U2lnbnVwV2l0aFVudmVyaWZpZWRFbWFpbCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRU1BSUxfTk9UX0ZPVU5ELCAnVXNlciBlbWFpbCBpcyBub3QgdmVyaWZpZWQuJyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5yZXNwb25zZTtcbiAgICB9KTtcbn07XG5cbi8vIFVzZXMgdGhlIEF1dGggb2JqZWN0IHRvIGdldCB0aGUgbGlzdCBvZiByb2xlcywgYWRkcyB0aGUgdXNlciBpZFxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VyQW5kUm9sZUFDTCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMucnVuT3B0aW9ucy5hY2wgPSBbJyonXTtcblxuICBpZiAodGhpcy5hdXRoLnVzZXIpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLmdldFVzZXJSb2xlcygpLnRoZW4ocm9sZXMgPT4ge1xuICAgICAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IHRoaXMucnVuT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbdGhpcy5hdXRoLnVzZXIuaWRdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmIChcbiAgICB0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmXG4gICAgIXRoaXMuYXV0aC5pc01hc3RlciAmJlxuICAgICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJlxuICAgIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTFcbiAgKSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICAnVGhpcyB1c2VyIGlzIG5vdCBhbGxvd2VkIHRvIGFjY2VzcyBub24tZXhpc3RlbnQgY2xhc3M6ICcgKyB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHRoaXMuY29uZmlnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgc2NoZW1hLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZVNjaGVtYSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnZhbGlkYXRlT2JqZWN0KFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRoaXMuZGF0YSxcbiAgICB0aGlzLnF1ZXJ5LFxuICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICB0aGlzLmF1dGguaXNNYWludGVuYW5jZVxuICApO1xufTtcblxuLy8gUnVucyBhbnkgYmVmb3JlU2F2ZSB0cmlnZ2VycyBhZ2FpbnN0IHRoaXMgb3BlcmF0aW9uLlxuLy8gQW55IGNoYW5nZSBsZWFkcyB0byBvdXIgZGF0YSBiZWluZyBtdXRhdGVkLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5CZWZvcmVTYXZlVHJpZ2dlciA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5ydW5PcHRpb25zLm1hbnkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdiZWZvcmVTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBpZiAoXG4gICAgIXRyaWdnZXJzLnRyaWdnZXJFeGlzdHModGhpcy5jbGFzc05hbWUsIHRyaWdnZXJzLlR5cGVzLmJlZm9yZVNhdmUsIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWQpXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGNvbnN0IHsgb3JpZ2luYWxPYmplY3QsIHVwZGF0ZWRPYmplY3QgfSA9IHRoaXMuYnVpbGRQYXJzZU9iamVjdHMoKTtcbiAgY29uc3QgaWRlbnRpZmllciA9IHVwZGF0ZWRPYmplY3QuX2dldFN0YXRlSWRlbnRpZmllcigpO1xuICBjb25zdCBzdGF0ZUNvbnRyb2xsZXIgPSBQYXJzZS5Db3JlTWFuYWdlci5nZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIoKTtcbiAgY29uc3QgW3BlbmRpbmddID0gc3RhdGVDb250cm9sbGVyLmdldFBlbmRpbmdPcHMoaWRlbnRpZmllcik7XG4gIHRoaXMucGVuZGluZ09wcyA9IHtcbiAgICBvcGVyYXRpb25zOiB7IC4uLnBlbmRpbmcgfSxcbiAgICBpZGVudGlmaWVyLFxuICB9O1xuXG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIEJlZm9yZSBjYWxsaW5nIHRoZSB0cmlnZ2VyLCB2YWxpZGF0ZSB0aGUgcGVybWlzc2lvbnMgZm9yIHRoZSBzYXZlIG9wZXJhdGlvblxuICAgICAgbGV0IGRhdGFiYXNlUHJvbWlzZSA9IG51bGw7XG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgdXBkYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICB0cnVlLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFZhbGlkYXRlIGZvciBjcmVhdGluZ1xuICAgICAgICBkYXRhYmFzZVByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS5jcmVhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBJbiB0aGUgY2FzZSB0aGF0IHRoZXJlIGlzIG5vIHBlcm1pc3Npb24gZm9yIHRoZSBvcGVyYXRpb24sIGl0IHRocm93cyBhbiBlcnJvclxuICAgICAgcmV0dXJuIGRhdGFiYXNlUHJvbWlzZS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmICghcmVzdWx0IHx8IHJlc3VsdC5sZW5ndGggPD0gMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZC4nKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLFxuICAgICAgICB0aGlzLmF1dGgsXG4gICAgICAgIHVwZGF0ZWRPYmplY3QsXG4gICAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgICB0aGlzLmNvbmZpZyxcbiAgICAgICAgdGhpcy5jb250ZXh0XG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgaWYgKHJlc3BvbnNlICYmIHJlc3BvbnNlLm9iamVjdCkge1xuICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciA9IF8ucmVkdWNlKFxuICAgICAgICAgIHJlc3BvbnNlLm9iamVjdCxcbiAgICAgICAgICAocmVzdWx0LCB2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFcXVhbCh0aGlzLmRhdGFba2V5XSwgdmFsdWUpKSB7XG4gICAgICAgICAgICAgIHJlc3VsdC5wdXNoKGtleSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgIH0sXG4gICAgICAgICAgW11cbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5kYXRhID0gcmVzcG9uc2Uub2JqZWN0O1xuICAgICAgICAvLyBXZSBzaG91bGQgZGVsZXRlIHRoZSBvYmplY3RJZCBmb3IgYW4gdXBkYXRlIHdyaXRlXG4gICAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBVdGlscy5jaGVja1Byb2hpYml0ZWRLZXl3b3Jkcyh0aGlzLmNvbmZpZywgdGhpcy5kYXRhKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCBgJHtlcnJvcn1gKTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQmVmb3JlTG9naW5UcmlnZ2VyID0gYXN5bmMgZnVuY3Rpb24gKHVzZXJEYXRhKSB7XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2JlZm9yZUxvZ2luJyB0cmlnZ2VyXG4gIGlmIChcbiAgICAhdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyh0aGlzLmNsYXNzTmFtZSwgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlTG9naW4sIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWQpXG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENsb3VkIGNvZGUgZ2V0cyBhIGJpdCBvZiBleHRyYSBkYXRhIGZvciBpdHMgb2JqZWN0c1xuICBjb25zdCBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUgfTtcblxuICAvLyBFeHBhbmQgZmlsZSBvYmplY3RzXG4gIGF3YWl0IHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHRoaXMuY29uZmlnLCB1c2VyRGF0YSk7XG5cbiAgY29uc3QgdXNlciA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB1c2VyRGF0YSk7XG5cbiAgLy8gbm8gbmVlZCB0byByZXR1cm4gYSByZXNwb25zZVxuICBhd2FpdCB0cmlnZ2Vycy5tYXliZVJ1blRyaWdnZXIoXG4gICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlTG9naW4sXG4gICAgdGhpcy5hdXRoLFxuICAgIHVzZXIsXG4gICAgbnVsbCxcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmNvbnRleHRcbiAgKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuc2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuZGF0YSkge1xuICAgIHJldHVybiB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlci5nZXRBbGxDbGFzc2VzKCkudGhlbihhbGxDbGFzc2VzID0+IHtcbiAgICAgIGNvbnN0IHNjaGVtYSA9IGFsbENsYXNzZXMuZmluZChvbmVDbGFzcyA9PiBvbmVDbGFzcy5jbGFzc05hbWUgPT09IHRoaXMuY2xhc3NOYW1lKTtcbiAgICAgIGNvbnN0IHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCA9IChmaWVsZE5hbWUsIHNldERlZmF1bHQpID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gbnVsbCB8fFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnJyB8fFxuICAgICAgICAgICh0eXBlb2YgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09ICdvYmplY3QnICYmIHRoaXMuZGF0YVtmaWVsZE5hbWVdLl9fb3AgPT09ICdEZWxldGUnKVxuICAgICAgICApIHtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBzZXREZWZhdWx0ICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5kZWZhdWx0VmFsdWUgIT09IG51bGwgJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5kZWZhdWx0VmFsdWUgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAgICAgKHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICAgICAgKHR5cGVvZiB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gJ29iamVjdCcgJiYgdGhpcy5kYXRhW2ZpZWxkTmFtZV0uX19vcCA9PT0gJ0RlbGV0ZScpKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlO1xuICAgICAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciB8fCBbXTtcbiAgICAgICAgICAgIGlmICh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5pbmRleE9mKGZpZWxkTmFtZSkgPCAwKSB7XG4gICAgICAgICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucmVxdWlyZWQgPT09IHRydWUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBgJHtmaWVsZE5hbWV9IGlzIHJlcXVpcmVkYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICAvLyBhZGQgZGVmYXVsdCBBQ0wgKG9ubHkgb24gQ1JFQVRFLCBub3QgVVBEQVRFKVxuICAgICAgaWYgKCF0aGlzLnF1ZXJ5ICYmXG4gICAgICAgIHNjaGVtYT8uY2xhc3NMZXZlbFBlcm1pc3Npb25zPy5BQ0wgJiZcbiAgICAgICAgIXRoaXMuZGF0YS5BQ0wgJiZcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkoc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucy5BQ0wpICE9PVxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHsgJyonOiB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH0gfSlcbiAgICAgICkge1xuICAgICAgICBjb25zdCBhY2wgPSBzdHJ1Y3R1cmVkQ2xvbmUoc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucy5BQ0wpO1xuICAgICAgICBpZiAoYWNsLmN1cnJlbnRVc2VyKSB7XG4gICAgICAgICAgaWYgKHRoaXMuYXV0aC51c2VyPy5pZCkge1xuICAgICAgICAgICAgYWNsW3RoaXMuYXV0aC51c2VyPy5pZF0gPSBzdHJ1Y3R1cmVkQ2xvbmUoYWNsLmN1cnJlbnRVc2VyKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZGVsZXRlIGFjbC5jdXJyZW50VXNlcjtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmRhdGEuQUNMID0gYWNsO1xuICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciA9IHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIHx8IFtdO1xuICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5wdXNoKCdBQ0wnKTtcbiAgICAgIH1cblxuICAgICAgLy8gQWRkIGRlZmF1bHQgZmllbGRzXG4gICAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgICAgLy8gYWxsb3cgY3VzdG9taXppbmcgY3JlYXRlZEF0IGFuZCB1cGRhdGVkQXQgd2hlbiB1c2luZyBtYWludGVuYW5jZSBrZXlcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuYXV0aC5pc01haW50ZW5hbmNlICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQuX190eXBlID09PSAnRGF0ZSdcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCA9IHRoaXMuZGF0YS5jcmVhdGVkQXQuaXNvO1xuXG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS51cGRhdGVkQXQgJiYgdGhpcy5kYXRhLnVwZGF0ZWRBdC5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgICAgICAgY29uc3QgY3JlYXRlZEF0ID0gbmV3IERhdGUodGhpcy5kYXRhLmNyZWF0ZWRBdCk7XG4gICAgICAgICAgICBjb25zdCB1cGRhdGVkQXQgPSBuZXcgRGF0ZSh0aGlzLmRhdGEudXBkYXRlZEF0Lmlzbyk7XG5cbiAgICAgICAgICAgIGlmICh1cGRhdGVkQXQgPCBjcmVhdGVkQXQpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgICAgJ3VwZGF0ZWRBdCBjYW5ub3Qgb2NjdXIgYmVmb3JlIGNyZWF0ZWRBdCdcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5kYXRhLnVwZGF0ZWRBdCA9IHRoaXMuZGF0YS51cGRhdGVkQXQuaXNvO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBpZiBubyB1cGRhdGVkQXQgaXMgcHJvdmlkZWQsIHNldCBpdCB0byBjcmVhdGVkQXQgdG8gbWF0Y2ggZGVmYXVsdCBiZWhhdmlvclxuICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5kYXRhLnVwZGF0ZWRBdCA9IHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICAgICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBPbmx5IGFzc2lnbiBuZXcgb2JqZWN0SWQgaWYgd2UgYXJlIGNyZWF0aW5nIG5ldyBvYmplY3RcbiAgICAgICAgaWYgKCF0aGlzLmRhdGEub2JqZWN0SWQpIHtcbiAgICAgICAgICB0aGlzLmRhdGEub2JqZWN0SWQgPSBjcnlwdG9VdGlscy5uZXdPYmplY3RJZCh0aGlzLmNvbmZpZy5vYmplY3RJZFNpemUpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzY2hlbWEpIHtcbiAgICAgICAgICBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICAgICAgICBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQoZmllbGROYW1lLCB0cnVlKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChzY2hlbWEpIHtcbiAgICAgICAgdGhpcy5kYXRhLnVwZGF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuXG4gICAgICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YSkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgIHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZChmaWVsZE5hbWUsIGZhbHNlKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuLy8gVHJhbnNmb3JtcyBhdXRoIGRhdGEgZm9yIGEgdXNlciBvYmplY3QuXG4vLyBEb2VzIG5vdGhpbmcgaWYgdGhpcyBpc24ndCBhIHVzZXIgb2JqZWN0LlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUF1dGhEYXRhID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBhdXRoRGF0YSA9IHRoaXMuZGF0YS5hdXRoRGF0YTtcbiAgY29uc3QgaGFzVXNlcm5hbWVBbmRQYXNzd29yZCA9XG4gICAgdHlwZW9mIHRoaXMuZGF0YS51c2VybmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIHRoaXMuZGF0YS5wYXNzd29yZCA9PT0gJ3N0cmluZyc7XG4gIGNvbnN0IGhhc0F1dGhEYXRhID1cbiAgICBhdXRoRGF0YSAmJlxuICAgIE9iamVjdC5rZXlzKGF1dGhEYXRhKS5zb21lKHByb3ZpZGVyID0+IHtcbiAgICAgIGNvbnN0IHByb3ZpZGVyRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgIHJldHVybiBwcm92aWRlckRhdGEgJiYgdHlwZW9mIHByb3ZpZGVyRGF0YSA9PT0gJ29iamVjdCcgJiYgT2JqZWN0LmtleXMocHJvdmlkZXJEYXRhKS5sZW5ndGg7XG4gICAgfSk7XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICFoYXNBdXRoRGF0YSkge1xuICAgIGlmICh0eXBlb2YgdGhpcy5kYXRhLnVzZXJuYW1lICE9PSAnc3RyaW5nJyB8fCBfLmlzRW1wdHkodGhpcy5kYXRhLnVzZXJuYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlVTRVJOQU1FX01JU1NJTkcsICdiYWQgb3IgbWlzc2luZyB1c2VybmFtZScpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHRoaXMuZGF0YS5wYXNzd29yZCAhPT0gJ3N0cmluZycgfHwgXy5pc0VtcHR5KHRoaXMuZGF0YS5wYXNzd29yZCkpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5QQVNTV09SRF9NSVNTSU5HLCAncGFzc3dvcmQgaXMgcmVxdWlyZWQnKTtcbiAgICB9XG4gIH1cblxuICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh0aGlzLmRhdGEsICdhdXRoRGF0YScpKSB7XG4gICAgLy8gTm90aGluZyB0byB2YWxpZGF0ZSBoZXJlXG4gICAgcmV0dXJuO1xuICB9IGVsc2UgaWYgKCF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICAvLyBIYW5kbGUgc2F2aW5nIGF1dGhEYXRhIHRvIG51bGxcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLidcbiAgICApO1xuICB9XG5cbiAgdmFyIHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgaWYgKCFwcm92aWRlcnMubGVuZ3RoKSB7XG4gICAgLy8gRW1wdHkgYXV0aERhdGEgb2JqZWN0LCBub3RoaW5nIHRvIHZhbGlkYXRlXG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGNhbkhhbmRsZUF1dGhEYXRhID0gcHJvdmlkZXJzLnNvbWUocHJvdmlkZXIgPT4ge1xuICAgIGNvbnN0IHByb3ZpZGVyQXV0aERhdGEgPSBhdXRoRGF0YVtwcm92aWRlcl0gfHwge307XG4gICAgcmV0dXJuICEhT2JqZWN0LmtleXMocHJvdmlkZXJBdXRoRGF0YSkubGVuZ3RoO1xuICB9KTtcbiAgaWYgKGNhbkhhbmRsZUF1dGhEYXRhIHx8IGhhc1VzZXJuYW1lQW5kUGFzc3dvcmQgfHwgdGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuZ2V0VXNlcklkKCkpIHtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoRGF0YShhdXRoRGF0YSk7XG4gIH1cbiAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgIFBhcnNlLkVycm9yLlVOU1VQUE9SVEVEX1NFUlZJQ0UsXG4gICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLidcbiAgKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZmlsdGVyZWRPYmplY3RzQnlBQ0wgPSBmdW5jdGlvbiAob2JqZWN0cykge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuIG9iamVjdHM7XG4gIH1cbiAgcmV0dXJuIG9iamVjdHMuZmlsdGVyKG9iamVjdCA9PiB7XG4gICAgaWYgKCFvYmplY3QuQUNMKSB7XG4gICAgICByZXR1cm4gdHJ1ZTsgLy8gbGVnYWN5IHVzZXJzIHRoYXQgaGF2ZSBubyBBQ0wgZmllbGQgb24gdGhlbVxuICAgIH1cbiAgICAvLyBSZWd1bGFyIHVzZXJzIHRoYXQgaGF2ZSBiZWVuIGxvY2tlZCBvdXQuXG4gICAgcmV0dXJuIG9iamVjdC5BQ0wgJiYgT2JqZWN0LmtleXMob2JqZWN0LkFDTCkubGVuZ3RoID4gMDtcbiAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmdldFVzZXJJZCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCAmJiB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIHJldHVybiB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICB9IGVsc2UgaWYgKHRoaXMuYXV0aCAmJiB0aGlzLmF1dGgudXNlciAmJiB0aGlzLmF1dGgudXNlci5pZCkge1xuICAgIHJldHVybiB0aGlzLmF1dGgudXNlci5pZDtcbiAgfVxufTtcblxuLy8gRGV2ZWxvcGVycyBhcmUgYWxsb3dlZCB0byBjaGFuZ2UgYXV0aERhdGEgdmlhIGJlZm9yZSBzYXZlIHRyaWdnZXJcblJlc3RXcml0ZS5wcm90b3R5cGUuX3Rocm93SWZBdXRoRGF0YUR1cGxpY2F0ZSA9IGZ1bmN0aW9uIChlcnJvcikge1xuICBpZiAoXG4gICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICBlcnJvcj8uY29kZSA9PT0gUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFICYmXG4gICAgZXJyb3IudXNlckluZm8/LmR1cGxpY2F0ZWRfZmllbGQ/LnN0YXJ0c1dpdGgoJ19hdXRoX2RhdGFfJylcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsICd0aGlzIGF1dGggaXMgYWxyZWFkeSB1c2VkJyk7XG4gIH1cbn07XG5cbi8vIHdlIG5lZWQgYWZ0ZXIgYmVmb3JlIHNhdmUgdG8gZW5zdXJlIHRoYXQgdGhlIGRldmVsb3BlclxuLy8gaXMgbm90IGN1cnJlbnRseSBkdXBsaWNhdGluZyBhdXRoIGRhdGEgSURcblJlc3RXcml0ZS5wcm90b3R5cGUuZW5zdXJlVW5pcXVlQXV0aERhdGFJZCA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8ICF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBoYXNBdXRoRGF0YUlkID0gT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5zb21lKFxuICAgIGtleSA9PiB0aGlzLmRhdGEuYXV0aERhdGFba2V5XSAmJiB0aGlzLmRhdGEuYXV0aERhdGFba2V5XS5pZFxuICApO1xuXG4gIGlmICghaGFzQXV0aERhdGFJZCkgeyByZXR1cm47IH1cblxuICBjb25zdCByID0gYXdhaXQgQXV0aC5maW5kVXNlcnNXaXRoQXV0aERhdGEodGhpcy5jb25maWcsIHRoaXMuZGF0YS5hdXRoRGF0YSk7XG4gIGNvbnN0IHJlc3VsdHMgPSB0aGlzLmZpbHRlcmVkT2JqZWN0c0J5QUNMKHIpO1xuICBpZiAocmVzdWx0cy5sZW5ndGggPiAxKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsICd0aGlzIGF1dGggaXMgYWxyZWFkeSB1c2VkJyk7XG4gIH1cbiAgLy8gdXNlIGRhdGEub2JqZWN0SWQgaW4gY2FzZSBvZiBsb2dpbiB0aW1lIGFuZCBmb3VuZCB1c2VyIGR1cmluZyBoYW5kbGUgdmFsaWRhdGVBdXRoRGF0YVxuICBjb25zdCB1c2VySWQgPSB0aGlzLmdldFVzZXJJZCgpIHx8IHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgaWYgKHJlc3VsdHMubGVuZ3RoID09PSAxICYmIHVzZXJJZCAhPT0gcmVzdWx0c1swXS5vYmplY3RJZCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUF1dGhEYXRhID0gYXN5bmMgZnVuY3Rpb24gKGF1dGhEYXRhKSB7XG4gIGxldCBjdXJyZW50VXNlckF1dGhEYXRhO1xuICBpZiAodGhpcy5xdWVyeT8ub2JqZWN0SWQpIHtcbiAgICBjb25zdCBbY3VycmVudFVzZXJdID0gYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICdfVXNlcicsXG4gICAgICB7IG9iamVjdElkOiB0aGlzLnF1ZXJ5Lm9iamVjdElkIH1cbiAgICApO1xuICAgIGN1cnJlbnRVc2VyQXV0aERhdGEgPSBjdXJyZW50VXNlcj8uYXV0aERhdGE7XG4gIH1cbiAgY29uc3QgciA9IGF3YWl0IEF1dGguZmluZFVzZXJzV2l0aEF1dGhEYXRhKHRoaXMuY29uZmlnLCBhdXRoRGF0YSwgdHJ1ZSwgY3VycmVudFVzZXJBdXRoRGF0YSk7XG4gIGNvbnN0IHJlc3VsdHMgPSB0aGlzLmZpbHRlcmVkT2JqZWN0c0J5QUNMKHIpO1xuXG4gIGNvbnN0IHVzZXJJZCA9IHRoaXMuZ2V0VXNlcklkKCk7XG4gIGNvbnN0IHVzZXJSZXN1bHQgPSByZXN1bHRzWzBdO1xuICBjb25zdCBmb3VuZFVzZXJJc05vdEN1cnJlbnRVc2VyID0gdXNlcklkICYmIHVzZXJSZXN1bHQgJiYgdXNlcklkICE9PSB1c2VyUmVzdWx0Lm9iamVjdElkO1xuXG4gIGlmIChyZXN1bHRzLmxlbmd0aCA+IDEgfHwgZm91bmRVc2VySXNOb3RDdXJyZW50VXNlcikge1xuICAgIC8vIFRvIGF2b2lkIGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL3NlY3VyaXR5L2Fkdmlzb3JpZXMvR0hTQS04dzNqLWc5ODMtOGpoNVxuICAgIC8vIExldCdzIHJ1biBzb21lIHZhbGlkYXRpb24gYmVmb3JlIHRocm93aW5nXG4gICAgYXdhaXQgQXV0aC5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24oYXV0aERhdGEsIHRoaXMsIHVzZXJSZXN1bHQpO1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG5cbiAgLy8gTm8gdXNlciBmb3VuZCB3aXRoIHByb3ZpZGVkIGF1dGhEYXRhIHdlIG5lZWQgdG8gdmFsaWRhdGVcbiAgaWYgKCFyZXN1bHRzLmxlbmd0aCkge1xuICAgIGNvbnN0IHsgYXV0aERhdGE6IHZhbGlkYXRlZEF1dGhEYXRhLCBhdXRoRGF0YVJlc3BvbnNlIH0gPSBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihcbiAgICAgIGF1dGhEYXRhLFxuICAgICAgdGhpc1xuICAgICk7XG4gICAgdGhpcy5hdXRoRGF0YVJlc3BvbnNlID0gYXV0aERhdGFSZXNwb25zZTtcbiAgICAvLyBSZXBsYWNlIGN1cnJlbnQgYXV0aERhdGEgYnkgdGhlIG5ldyB2YWxpZGF0ZWQgb25lXG4gICAgdGhpcy5kYXRhLmF1dGhEYXRhID0gdmFsaWRhdGVkQXV0aERhdGE7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVXNlciBmb3VuZCB3aXRoIHByb3ZpZGVkIGF1dGhEYXRhXG4gIGlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMSkge1xuICAgIHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSkuam9pbignLCcpO1xuXG4gICAgY29uc3QgeyBoYXNNdXRhdGVkQXV0aERhdGEsIG11dGF0ZWRBdXRoRGF0YSB9ID0gQXV0aC5oYXNNdXRhdGVkQXV0aERhdGEoXG4gICAgICBhdXRoRGF0YSxcbiAgICAgIHVzZXJSZXN1bHQuYXV0aERhdGFcbiAgICApO1xuXG4gICAgY29uc3QgaXNDdXJyZW50VXNlckxvZ2dlZE9yTWFzdGVyID1cbiAgICAgICh0aGlzLmF1dGggJiYgdGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5hdXRoLnVzZXIuaWQgPT09IHVzZXJSZXN1bHQub2JqZWN0SWQpIHx8XG4gICAgICB0aGlzLmF1dGguaXNNYXN0ZXI7XG5cbiAgICBjb25zdCBpc0xvZ2luID0gIXVzZXJJZDtcblxuICAgIGlmIChpc0xvZ2luIHx8IGlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3Rlcikge1xuICAgICAgLy8gbm8gdXNlciBtYWtpbmcgdGhlIGNhbGxcbiAgICAgIC8vIE9SIHRoZSB1c2VyIG1ha2luZyB0aGUgY2FsbCBpcyB0aGUgcmlnaHQgb25lXG4gICAgICAvLyBMb2dpbiB3aXRoIGF1dGggZGF0YVxuICAgICAgZGVsZXRlIHJlc3VsdHNbMF0ucGFzc3dvcmQ7XG5cbiAgICAgIC8vIG5lZWQgdG8gc2V0IHRoZSBvYmplY3RJZCBmaXJzdCBvdGhlcndpc2UgbG9jYXRpb24gaGFzIHRyYWlsaW5nIHVuZGVmaW5lZFxuICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gdXNlclJlc3VsdC5vYmplY3RJZDtcblxuICAgICAgaWYgKCF0aGlzLnF1ZXJ5IHx8ICF0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgICAgcmVzcG9uc2U6IHVzZXJSZXN1bHQsXG4gICAgICAgICAgbG9jYXRpb246IHRoaXMubG9jYXRpb24oKSxcbiAgICAgICAgfTtcbiAgICAgICAgLy8gUnVuIGJlZm9yZUxvZ2luIGhvb2sgYmVmb3JlIHN0b3JpbmcgYW55IHVwZGF0ZXNcbiAgICAgICAgLy8gdG8gYXV0aERhdGEgb24gdGhlIGRiOyBjaGFuZ2VzIHRvIHVzZXJSZXN1bHRcbiAgICAgICAgLy8gd2lsbCBiZSBpZ25vcmVkLlxuICAgICAgICBhd2FpdCB0aGlzLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlcihzdHJ1Y3R1cmVkQ2xvbmUodXNlclJlc3VsdCkpO1xuXG4gICAgICAgIC8vIElmIHdlIGFyZSBpbiBsb2dpbiBvcGVyYXRpb24gdmlhIGF1dGhEYXRhXG4gICAgICAgIC8vIHdlIG5lZWQgdG8gYmUgc3VyZSB0aGF0IHRoZSB1c2VyIGhhcyBwcm92aWRlZFxuICAgICAgICAvLyByZXF1aXJlZCBhdXRoRGF0YVxuICAgICAgICBBdXRoLmNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4oXG4gICAgICAgICAgeyBjb25maWc6IHRoaXMuY29uZmlnLCBhdXRoOiB0aGlzLmF1dGggfSxcbiAgICAgICAgICBhdXRoRGF0YSxcbiAgICAgICAgICB1c2VyUmVzdWx0LmF1dGhEYXRhLFxuICAgICAgICAgIHRoaXMuY29uZmlnXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIC8vIFByZXZlbnQgdmFsaWRhdGluZyBpZiBubyBtdXRhdGVkIGRhdGEgZGV0ZWN0ZWQgb24gdXBkYXRlXG4gICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSAmJiBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBBbHdheXMgdmFsaWRhdGUgYWxsIHByb3ZpZGVkIGF1dGhEYXRhIG9uIGxvZ2luIHRvIHByZXZlbnQgYXV0aGVudGljYXRpb25cbiAgICAgIC8vIGJ5cGFzcyB2aWEgcGFydGlhbCBhdXRoRGF0YSAoZS5nLiBzZW5kaW5nIG9ubHkgdGhlIHByb3ZpZGVyIElEIHdpdGhvdXRcbiAgICAgIC8vIGFuIGFjY2VzcyB0b2tlbik7IG9uIHVwZGF0ZSBvbmx5IHZhbGlkYXRlIG11dGF0ZWQgb25lc1xuICAgICAgaWYgKGlzTG9naW4gfHwgaGFzTXV0YXRlZEF1dGhEYXRhIHx8ICF0aGlzLmNvbmZpZy5hbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuKSB7XG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IEF1dGguaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKFxuICAgICAgICAgIGlzTG9naW4gPyBhdXRoRGF0YSA6IG11dGF0ZWRBdXRoRGF0YSxcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgIHVzZXJSZXN1bHRcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5kYXRhLmF1dGhEYXRhID0gcmVzLmF1dGhEYXRhO1xuICAgICAgICB0aGlzLmF1dGhEYXRhUmVzcG9uc2UgPSByZXMuYXV0aERhdGFSZXNwb25zZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2FwdHVyZSBvcmlnaW5hbCBhdXRoRGF0YSBiZWZvcmUgbXV0YXRpbmcgdXNlclJlc3VsdCB2aWEgdGhlIHJlc3BvbnNlIHJlZmVyZW5jZVxuICAgICAgY29uc3Qgb3JpZ2luYWxBdXRoRGF0YSA9IHVzZXJSZXN1bHQ/LmF1dGhEYXRhXG4gICAgICAgID8gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgIE9iamVjdC5lbnRyaWVzKHVzZXJSZXN1bHQuYXV0aERhdGEpLm1hcCgoW2ssIHZdKSA9PlxuICAgICAgICAgICAgW2ssIHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnID8geyAuLi52IH0gOiB2XVxuICAgICAgICAgIClcbiAgICAgICAgKVxuICAgICAgICA6IHVuZGVmaW5lZDtcblxuICAgICAgLy8gSUYgd2UgYXJlIGluIGxvZ2luIHdlJ2xsIHNraXAgdGhlIGRhdGFiYXNlIG9wZXJhdGlvbiAvIGJlZm9yZVNhdmUgLyBhZnRlclNhdmUgZXRjLi4uXG4gICAgICAvLyB3ZSBuZWVkIHRvIHNldCBpdCB1cCB0aGVyZS5cbiAgICAgIC8vIFdlIGFyZSBzdXBwb3NlZCB0byBoYXZlIGEgcmVzcG9uc2Ugb25seSBvbiBMT0dJTiB3aXRoIGF1dGhEYXRhLCBzbyB3ZSBza2lwIHRob3NlXG4gICAgICAvLyBJZiB3ZSdyZSBub3QgbG9nZ2luZyBpbiwgYnV0IGp1c3QgdXBkYXRpbmcgdGhlIGN1cnJlbnQgdXNlciwgd2UgY2FuIHNhZmVseSBza2lwIHRoYXQgcGFydFxuICAgICAgaWYgKHRoaXMucmVzcG9uc2UpIHtcbiAgICAgICAgLy8gQXNzaWduIHRoZSBuZXcgYXV0aERhdGEgaW4gdGhlIHJlc3BvbnNlXG4gICAgICAgIE9iamVjdC5rZXlzKG11dGF0ZWRBdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5hdXRoRGF0YVtwcm92aWRlcl0gPSBtdXRhdGVkQXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBSdW4gdGhlIERCIHVwZGF0ZSBkaXJlY3RseSwgYXMgJ21hc3Rlcicgb25seSBpZiBhdXRoRGF0YSBjb250YWlucyBzb21lIGtleXNcbiAgICAgICAgLy8gYXV0aERhdGEgY291bGQgbm90IGNvbnRhaW5zIGtleXMgYWZ0ZXIgdmFsaWRhdGlvbiBpZiB0aGUgYXV0aEFkYXB0ZXJcbiAgICAgICAgLy8gdXNlcyB0aGUgYGRvTm90U2F2ZWAgb3B0aW9uLiBKdXN0IHVwZGF0ZSB0aGUgYXV0aERhdGEgcGFydFxuICAgICAgICAvLyBUaGVuIHdlJ3JlIGdvb2QgZm9yIHRoZSB1c2VyLCBlYXJseSBleGl0IG9mIHNvcnRzXG4gICAgICAgIGlmIChPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCkge1xuICAgICAgICAgIGNvbnN0IHF1ZXJ5ID0geyBvYmplY3RJZDogdGhpcy5kYXRhLm9iamVjdElkIH07XG4gICAgICAgICAgLy8gT3B0aW1pc3RpYyBsb2NraW5nOiBpbmNsdWRlIGVhY2ggY2hhbmdlZCBvcmlnaW5hbCBmaWVsZCBpbiB0aGUgV0hFUkUgY2xhdXNlXG4gICAgICAgICAgLy8gZm9yIHByb3ZpZGVycyB3aG9zZSBkYXRhIGlzIGJlaW5nIHVwZGF0ZWQuIFRoaXMgcHJldmVudHMgY29uY3VycmVudCByZXF1ZXN0c1xuICAgICAgICAgIC8vIGZyb20gYm90aCBzdWNjZWVkaW5nIHdoZW4gY29uc3VtaW5nIHNpbmdsZS11c2UgdG9rZW5zIChlLmcuIE1GQSByZWNvdmVyeSBjb2Rlc1xuICAgICAgICAgIC8vIGFzIGFycmF5cywgb3IgTUZBIFNNUyBPVFAgdG9rZW5zIGFzIHN0cmluZ3MpLlxuICAgICAgICAgIGFwcGx5QXV0aERhdGFPcHRpbWlzdGljTG9jayhxdWVyeSwgb3JpZ2luYWxBdXRoRGF0YSwgdGhpcy5kYXRhLmF1dGhEYXRhKTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgIHsgYXV0aERhdGE6IHRoaXMuZGF0YS5hdXRoRGF0YSB9LFxuICAgICAgICAgICAgICB7fVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsICdJbnZhbGlkIGF1dGggZGF0YScpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5fdGhyb3dJZkF1dGhEYXRhRHVwbGljYXRlKGVycm9yKTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMuZGF0YS5hdXRoRGF0YSAmJiBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCkge1xuICAgICAgICAvLyBVUERBVEUgcGF0aCAoZS5nLiBQVVQgL3VzZXJzLzppZCBkdXJpbmcgbGlua2VkLXByb3ZpZGVyIHJlLWF1dGgpOiBhcHBseVxuICAgICAgICAvLyB0aGUgc2FtZSBvcHRpbWlzdGljIGxvY2sgdG8gdGhlIHN1YnNlcXVlbnQgcnVuRGF0YWJhc2VPcGVyYXRpb24gdXBkYXRlIHNvXG4gICAgICAgIC8vIGNvbmN1cnJlbnQgc2luZ2xlLXVzZSB0b2tlbiBjb25zdW1lcnMgY2Fubm90IGJvdGggc3VjY2VlZC5cbiAgICAgICAgYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrKHRoaXMucXVlcnksIG9yaWdpbmFsQXV0aERhdGEsIHRoaXMuZGF0YS5hdXRoRGF0YSk7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNoZWNrUmVzdHJpY3RlZEZpZWxkcyA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICdlbWFpbFZlcmlmaWVkJyBpbiB0aGlzLmRhdGEpIHtcbiAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICBcIkNsaWVudHMgYXJlbid0IGFsbG93ZWQgdG8gbWFudWFsbHkgdXBkYXRlIGVtYWlsIHZlcmlmaWNhdGlvbi5cIixcbiAgICAgIHRoaXMuY29uZmlnXG4gICAgKTtcbiAgfVxufTtcblxuLy8gVmFsaWRhdGVzIHRoZSBjcmVhdGUgY2xhc3MtbGV2ZWwgcGVybWlzc2lvbiBiZWZvcmUgdHJhbnNmb3JtVXNlciBydW5zLlxuLy8gVGhpcyBwcmV2ZW50cyB1c2VyIGVudW1lcmF0aW9uICh1c2VybmFtZS9lbWFpbCBleGlzdGVuY2UpIHdoZW4gcHVibGljXG4vLyBjcmVhdGUgaXMgZGlzYWJsZWQgb24gX1VzZXIsIGJlY2F1c2UgdHJhbnNmb3JtVXNlciBjaGVja3MgdW5pcXVlbmVzc1xuLy8gYmVmb3JlIHRoZSBDTFAgaXMgZW5mb3JjZWQgaW4gcnVuRGF0YWJhc2VPcGVyYXRpb24uXG5SZXN0V3JpdGUucHJvdG90eXBlLnZhbGlkYXRlQ3JlYXRlUGVybWlzc2lvbiA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucXVlcnkgfHwgdGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRoaXMucnVuT3B0aW9ucy5hY2wgfHwgW10sXG4gICAgJ2NyZWF0ZSdcbiAgKTtcbn07XG5cbi8vIFRoZSBub24tdGhpcmQtcGFydHkgcGFydHMgb2YgVXNlciB0cmFuc2Zvcm1hdGlvblxuUmVzdFdyaXRlLnByb3RvdHlwZS50cmFuc2Zvcm1Vc2VyID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIC8vIERvIG5vdCBjbGVhbnVwIHNlc3Npb24gaWYgb2JqZWN0SWQgaXMgbm90IHNldFxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLm9iamVjdElkKCkpIHtcbiAgICAvLyBJZiB3ZSdyZSB1cGRhdGluZyBhIF9Vc2VyIG9iamVjdCwgd2UgbmVlZCB0byBjbGVhciBvdXQgdGhlIGNhY2hlIGZvciB0aGF0IHVzZXIuIEZpbmQgYWxsIHRoZWlyXG4gICAgLy8gc2Vzc2lvbiB0b2tlbnMsIGFuZCByZW1vdmUgdGhlbSBmcm9tIHRoZSBjYWNoZS5cbiAgICBjb25zdCBxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZmluZCxcbiAgICAgIGNvbmZpZzogdGhpcy5jb25maWcsXG4gICAgICBhdXRoOiBBdXRoLm1hc3Rlcih0aGlzLmNvbmZpZyksXG4gICAgICBjbGFzc05hbWU6ICdfU2Vzc2lvbicsXG4gICAgICBydW5CZWZvcmVGaW5kOiBmYWxzZSxcbiAgICAgIHJlc3RXaGVyZToge1xuICAgICAgICB1c2VyOiB7XG4gICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHByb21pc2UgPSBxdWVyeS5leGVjdXRlKCkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMucmVzdWx0cy5mb3JFYWNoKHNlc3Npb24gPT5cbiAgICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnVzZXIuZGVsKHNlc3Npb24uc2Vzc2lvblRva2VuKVxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBwcm9taXNlXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gVHJhbnNmb3JtIHRoZSBwYXNzd29yZFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIC8vIGlnbm9yZSBvbmx5IGlmIHVuZGVmaW5lZC4gc2hvdWxkIHByb2NlZWQgaWYgZW1wdHkgKCcnKVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddID0gdHJ1ZTtcbiAgICAgICAgLy8gR2VuZXJhdGUgYSBuZXcgc2Vzc2lvbiBvbmx5IGlmIHRoZSB1c2VyIHJlcXVlc3RlZFxuICAgICAgICBpZiAoIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICAgICAgICB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uaGFzaCh0aGlzLmRhdGEucGFzc3dvcmQpLnRoZW4oaGFzaGVkUGFzc3dvcmQgPT4ge1xuICAgICAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkID0gaGFzaGVkUGFzc3dvcmQ7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVVzZXJOYW1lKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVFbWFpbCgpO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVVc2VyTmFtZSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gQ2hlY2sgZm9yIHVzZXJuYW1lIHVuaXF1ZW5lc3NcbiAgaWYgKCF0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgIHRoaXMuZGF0YS51c2VybmFtZSA9IGNyeXB0b1V0aWxzLnJhbmRvbVN0cmluZygyNSk7XG4gICAgICB0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8qXG4gICAgVXNlcm5hbWVzIHNob3VsZCBiZSB1bmlxdWUgd2hlbiBjb21wYXJlZCBjYXNlIGluc2Vuc2l0aXZlbHlcblxuICAgIFVzZXJzIHNob3VsZCBiZSBhYmxlIHRvIG1ha2UgY2FzZSBzZW5zaXRpdmUgdXNlcm5hbWVzIGFuZFxuICAgIGxvZ2luIHVzaW5nIHRoZSBjYXNlIHRoZXkgZW50ZXJlZC4gIEkuZS4gJ1Nub29weScgc2hvdWxkIHByZWNsdWRlXG4gICAgJ3Nub29weScgYXMgYSB2YWxpZCB1c2VybmFtZS5cbiAgKi9cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHtcbiAgICAgICAgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSxcbiAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgIH0sXG4gICAgICB7IGxpbWl0OiAxLCBjYXNlSW5zZW5zaXRpdmU6IHRydWUgfSxcbiAgICAgIHt9LFxuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUuYnVpbGRDcmVhdGVkV2l0aCA9IGZ1bmN0aW9uIChhY3Rpb24sIGF1dGhQcm92aWRlcikge1xuICByZXR1cm4geyBhY3Rpb24sIGF1dGhQcm92aWRlcjogYXV0aFByb3ZpZGVyIHx8ICdwYXNzd29yZCcgfTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZ2V0Q3JlYXRlZFdpdGggPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnN0b3JhZ2UuY3JlYXRlZFdpdGgpIHtcbiAgICByZXR1cm4gdGhpcy5zdG9yYWdlLmNyZWF0ZWRXaXRoO1xuICB9XG4gIGNvbnN0IGlzQ3JlYXRlT3BlcmF0aW9uID0gIXRoaXMucXVlcnk7XG4gIGNvbnN0IGF1dGhEYXRhUHJvdmlkZXIgPVxuICAgIHRoaXMuZGF0YT8uYXV0aERhdGEgJiZcbiAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCAmJlxuICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkuam9pbignLCcpO1xuICBjb25zdCBhdXRoUHJvdmlkZXIgPSB0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyIHx8IGF1dGhEYXRhUHJvdmlkZXI7XG4gIC8vIHN0b3JhZ2UuYXV0aFByb3ZpZGVyIGlzIG9ubHkgc2V0IGZvciBsb2dpbiAoZXhpc3RpbmcgdXNlciBmb3VuZCBpbiBoYW5kbGVBdXRoRGF0YSlcbiAgY29uc3QgYWN0aW9uID0gdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA/ICdsb2dpbicgOiBpc0NyZWF0ZU9wZXJhdGlvbiA/ICdzaWdudXAnIDogdW5kZWZpbmVkO1xuICBpZiAoIWFjdGlvbikge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCByZXNvbHZlZEF1dGhQcm92aWRlciA9IGF1dGhQcm92aWRlciB8fCAoYWN0aW9uID09PSAnc2lnbnVwJyA/ICdwYXNzd29yZCcgOiB1bmRlZmluZWQpO1xuICB0aGlzLnN0b3JhZ2UuY3JlYXRlZFdpdGggPSBSZXN0V3JpdGUuYnVpbGRDcmVhdGVkV2l0aChhY3Rpb24sIHJlc29sdmVkQXV0aFByb3ZpZGVyKTtcbiAgcmV0dXJuIHRoaXMuc3RvcmFnZS5jcmVhdGVkV2l0aDtcbn07XG5cbi8qXG4gIEFzIHdpdGggdXNlcm5hbWVzLCBQYXJzZSBzaG91bGQgbm90IGFsbG93IGNhc2UgaW5zZW5zaXRpdmUgY29sbGlzaW9ucyBvZiBlbWFpbC5cbiAgdW5saWtlIHdpdGggdXNlcm5hbWVzICh3aGljaCBjYW4gaGF2ZSBjYXNlIGluc2Vuc2l0aXZlIGNvbGxpc2lvbnMgaW4gdGhlIGNhc2Ugb2ZcbiAgYXV0aCBhZGFwdGVycyksIGVtYWlscyBzaG91bGQgbmV2ZXIgaGF2ZSBhIGNhc2UgaW5zZW5zaXRpdmUgY29sbGlzaW9uLlxuXG4gIFRoaXMgYmVoYXZpb3IgY2FuIGJlIGVuZm9yY2VkIHRocm91Z2ggYSBwcm9wZXJseSBjb25maWd1cmVkIGluZGV4IHNlZTpcbiAgaHR0cHM6Ly9kb2NzLm1vbmdvZGIuY29tL21hbnVhbC9jb3JlL2luZGV4LWNhc2UtaW5zZW5zaXRpdmUvI2NyZWF0ZS1hLWNhc2UtaW5zZW5zaXRpdmUtaW5kZXhcbiAgd2hpY2ggY291bGQgYmUgaW1wbGVtZW50ZWQgaW5zdGVhZCBvZiB0aGlzIGNvZGUgYmFzZWQgdmFsaWRhdGlvbi5cblxuICBHaXZlbiB0aGF0IHRoaXMgbG9va3VwIHNob3VsZCBiZSBhIHJlbGF0aXZlbHkgbG93IHVzZSBjYXNlIGFuZCB0aGF0IHRoZSBjYXNlIHNlbnNpdGl2ZVxuICB1bmlxdWUgaW5kZXggd2lsbCBiZSB1c2VkIGJ5IHRoZSBkYiBmb3IgdGhlIHF1ZXJ5LCB0aGlzIGlzIGFuIGFkZXF1YXRlIHNvbHV0aW9uLlxuKi9cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlRW1haWwgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5kYXRhLmVtYWlsIHx8IHRoaXMuZGF0YS5lbWFpbC5fX29wID09PSAnRGVsZXRlJykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBWYWxpZGF0ZSBiYXNpYyBlbWFpbCBhZGRyZXNzIGZvcm1hdFxuICBpZiAoIXRoaXMuZGF0YS5lbWFpbC5tYXRjaCgvXi4rQC4rJC8pKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfRU1BSUxfQUREUkVTUywgJ0VtYWlsIGFkZHJlc3MgZm9ybWF0IGlzIGludmFsaWQuJylcbiAgICApO1xuICB9XG4gIC8vIENhc2UgaW5zZW5zaXRpdmUgbWF0Y2gsIHNlZSBub3RlIGFib3ZlIGZ1bmN0aW9uLlxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZChcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAge1xuICAgICAgICBlbWFpbDogdGhpcy5kYXRhLmVtYWlsLFxuICAgICAgICBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgfSxcbiAgICAgIHsgbGltaXQ6IDEsIGNhc2VJbnNlbnNpdGl2ZTogdHJ1ZSB9LFxuICAgICAge30sXG4gICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgIClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICAhdGhpcy5kYXRhLmF1dGhEYXRhIHx8XG4gICAgICAgICFPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCB8fFxuICAgICAgICAoT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGggPT09IDEgJiZcbiAgICAgICAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpWzBdID09PSAnYW5vbnltb3VzJylcbiAgICAgICkge1xuICAgICAgICAvLyBXZSB1cGRhdGVkIHRoZSBlbWFpbCwgc2VuZCBhIG5ldyB2YWxpZGF0aW9uXG4gICAgICAgIGNvbnN0IHsgb3JpZ2luYWxPYmplY3QsIHVwZGF0ZWRPYmplY3QgfSA9IHRoaXMuYnVpbGRQYXJzZU9iamVjdHMoKTtcbiAgICAgICAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAgICAgICBvcmlnaW5hbDogb3JpZ2luYWxPYmplY3QsXG4gICAgICAgICAgb2JqZWN0OiB1cGRhdGVkT2JqZWN0LFxuICAgICAgICAgIG1hc3RlcjogdGhpcy5hdXRoLmlzTWFzdGVyLFxuICAgICAgICAgIGlwOiB0aGlzLmNvbmZpZy5pcCxcbiAgICAgICAgICBpbnN0YWxsYXRpb25JZDogdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkLFxuICAgICAgICAgIGNyZWF0ZWRXaXRoOiB0aGlzLmdldENyZWF0ZWRXaXRoKCksXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZXRFbWFpbFZlcmlmeVRva2VuKHRoaXMuZGF0YSwgcmVxdWVzdCwgdGhpcy5zdG9yYWdlKTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kpIHsgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOyB9XG4gIHJldHVybiB0aGlzLl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzKCkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5KCk7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cyA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gY2hlY2sgaWYgdGhlIHBhc3N3b3JkIGNvbmZvcm1zIHRvIHRoZSBkZWZpbmVkIHBhc3N3b3JkIHBvbGljeSBpZiBjb25maWd1cmVkXG4gIC8vIElmIHdlIHNwZWNpZmllZCBhIGN1c3RvbSBlcnJvciBpbiBvdXIgY29uZmlndXJhdGlvbiB1c2UgaXQuXG4gIC8vIEV4YW1wbGU6IFwiUGFzc3dvcmRzIG11c3QgaW5jbHVkZSBhIENhcGl0YWwgTGV0dGVyLCBMb3dlcmNhc2UgTGV0dGVyLCBhbmQgYSBudW1iZXIuXCJcbiAgLy9cbiAgLy8gVGhpcyBpcyBlc3BlY2lhbGx5IHVzZWZ1bCBvbiB0aGUgZ2VuZXJpYyBcInBhc3N3b3JkIHJlc2V0XCIgcGFnZSxcbiAgLy8gYXMgaXQgYWxsb3dzIHRoZSBwcm9ncmFtbWVyIHRvIGNvbW11bmljYXRlIHNwZWNpZmljIHJlcXVpcmVtZW50cyBpbnN0ZWFkIG9mOlxuICAvLyBhLiBtYWtpbmcgdGhlIHVzZXIgZ3Vlc3Mgd2hhdHMgd3JvbmdcbiAgLy8gYi4gbWFraW5nIGEgY3VzdG9tIHBhc3N3b3JkIHJlc2V0IHBhZ2UgdGhhdCBzaG93cyB0aGUgcmVxdWlyZW1lbnRzXG4gIGNvbnN0IHBvbGljeUVycm9yID0gdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdGlvbkVycm9yXG4gICAgPyB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0aW9uRXJyb3JcbiAgICA6ICdQYXNzd29yZCBkb2VzIG5vdCBtZWV0IHRoZSBQYXNzd29yZCBQb2xpY3kgcmVxdWlyZW1lbnRzLic7XG4gIGNvbnN0IGNvbnRhaW5zVXNlcm5hbWVFcnJvciA9ICdQYXNzd29yZCBjYW5ub3QgY29udGFpbiB5b3VyIHVzZXJuYW1lLic7XG5cbiAgLy8gY2hlY2sgd2hldGhlciB0aGUgcGFzc3dvcmQgbWVldHMgdGhlIHBhc3N3b3JkIHN0cmVuZ3RoIHJlcXVpcmVtZW50c1xuICBpZiAoXG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnBhdHRlcm5WYWxpZGF0b3IgJiZcbiAgICAgICF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yKHRoaXMuZGF0YS5wYXNzd29yZCkpIHx8XG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRvckNhbGxiYWNrICYmXG4gICAgICAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sodGhpcy5kYXRhLnBhc3N3b3JkKSlcbiAgKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBwb2xpY3lFcnJvcikpO1xuICB9XG5cbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBjb250YWluIHVzZXJuYW1lXG4gIGlmICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgPT09IHRydWUpIHtcbiAgICBpZiAodGhpcy5kYXRhLnVzZXJuYW1lKSB7XG4gICAgICAvLyB1c2VybmFtZSBpcyBub3QgcGFzc2VkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHRoaXMuZGF0YS51c2VybmFtZSkgPj0gMClcbiAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBjb250YWluc1VzZXJuYW1lRXJyb3IpKTsgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyByZXRyaWV2ZSB0aGUgVXNlciBvYmplY3QgdXNpbmcgb2JqZWN0SWQgZHVyaW5nIHBhc3N3b3JkIHJlc2V0XG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHJlc3VsdHNbMF0udXNlcm5hbWUpID49IDApXG4gICAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBjb250YWluc1VzZXJuYW1lRXJyb3IpXG4gICAgICAgICk7IH1cbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5ID0gZnVuY3Rpb24gKCkge1xuICAvLyBjaGVjayB3aGV0aGVyIHBhc3N3b3JkIGlzIHJlcGVhdGluZyBmcm9tIHNwZWNpZmllZCBoaXN0b3J5XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmZpbmQoXG4gICAgICAgICdfVXNlcicsXG4gICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICB7IGtleXM6IFsnX3Bhc3N3b3JkX2hpc3RvcnknLCAnX2hhc2hlZF9wYXNzd29yZCddIH0sXG4gICAgICAgIEF1dGgubWFpbnRlbmFuY2UodGhpcy5jb25maWcpXG4gICAgICApXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgIGxldCBvbGRQYXNzd29yZHMgPSBbXTtcbiAgICAgICAgaWYgKHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnkpXG4gICAgICAgIHsgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgIHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksXG4gICAgICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5IC0gMVxuICAgICAgICApOyB9XG4gICAgICAgIG9sZFBhc3N3b3Jkcy5wdXNoKHVzZXIucGFzc3dvcmQpO1xuICAgICAgICBjb25zdCBuZXdQYXNzd29yZCA9IHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgLy8gY29tcGFyZSB0aGUgbmV3IHBhc3N3b3JkIGhhc2ggd2l0aCBhbGwgb2xkIHBhc3N3b3JkIGhhc2hlc1xuICAgICAgICBjb25zdCBwcm9taXNlcyA9IG9sZFBhc3N3b3Jkcy5tYXAoZnVuY3Rpb24gKGhhc2gpIHtcbiAgICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uY29tcGFyZShuZXdQYXNzd29yZCwgaGFzaCkudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdClcbiAgICAgICAgICAgIC8vIHJlamVjdCBpZiB0aGVyZSBpcyBhIG1hdGNoXG4gICAgICAgICAgICB7IHJldHVybiBQcm9taXNlLnJlamVjdCgnUkVQRUFUX1BBU1NXT1JEJyk7IH1cbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIHdhaXQgZm9yIGFsbCBjb21wYXJpc29ucyB0byBjb21wbGV0ZVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwocHJvbWlzZXMpXG4gICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyID09PSAnUkVQRUFUX1BBU1NXT1JEJylcbiAgICAgICAgICAgIC8vIGEgbWF0Y2ggd2FzIGZvdW5kXG4gICAgICAgICAgICB7IHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgICAgYE5ldyBwYXNzd29yZCBzaG91bGQgbm90IGJlIHRoZSBzYW1lIGFzIGxhc3QgJHt0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3Rvcnl9IHBhc3N3b3Jkcy5gXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7IH1cbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEb24ndCBnZW5lcmF0ZSBzZXNzaW9uIGZvciB1cGRhdGluZyB1c2VyICh0aGlzLnF1ZXJ5IGlzIHNldCkgdW5sZXNzIGF1dGhEYXRhIGV4aXN0c1xuICBpZiAodGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERvbid0IGdlbmVyYXRlIG5ldyBzZXNzaW9uVG9rZW4gaWYgbGlua2luZyB2aWEgc2Vzc2lvblRva2VuXG4gIGlmICh0aGlzLmF1dGgudXNlciAmJiB0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gSWYgc2lnbi11cCBjYWxsXG4gIGlmICghdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlcikge1xuICAgIC8vIENyZWF0ZSByZXF1ZXN0IG9iamVjdCBmb3IgdmVyaWZpY2F0aW9uIGZ1bmN0aW9uc1xuICAgIGNvbnN0IHsgb3JpZ2luYWxPYmplY3QsIHVwZGF0ZWRPYmplY3QgfSA9IHRoaXMuYnVpbGRQYXJzZU9iamVjdHMoKTtcbiAgICBjb25zdCByZXF1ZXN0ID0ge1xuICAgICAgb3JpZ2luYWw6IG9yaWdpbmFsT2JqZWN0LFxuICAgICAgb2JqZWN0OiB1cGRhdGVkT2JqZWN0LFxuICAgICAgbWFzdGVyOiB0aGlzLmF1dGguaXNNYXN0ZXIsXG4gICAgICBpcDogdGhpcy5jb25maWcuaXAsXG4gICAgICBpbnN0YWxsYXRpb25JZDogdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkLFxuICAgICAgY3JlYXRlZFdpdGg6IHRoaXMuZ2V0Q3JlYXRlZFdpdGgoKSxcbiAgICB9O1xuICAgIC8vIEdldCB2ZXJpZmljYXRpb24gY29uZGl0aW9ucyB3aGljaCBjYW4gYmUgYm9vbGVhbnMgb3IgZnVuY3Rpb25zOyB0aGUgcHVycG9zZSBvZiB0aGlzIGFzeW5jL2F3YWl0XG4gICAgLy8gc3RydWN0dXJlIGlzIHRvIGF2b2lkIHVubmVjZXNzYXJpbHkgZXhlY3V0aW5nIHN1YnNlcXVlbnQgZnVuY3Rpb25zIGlmIHByZXZpb3VzIG9uZXMgZmFpbCBpbiB0aGVcbiAgICAvLyBjb25kaXRpb25hbCBzdGF0ZW1lbnQgYmVsb3csIGFzIGEgZGV2ZWxvcGVyIG1heSBkZWNpZGUgdG8gZXhlY3V0ZSBleHBlbnNpdmUgb3BlcmF0aW9ucyBpbiB0aGVtXG4gICAgY29uc3QgdmVyaWZ5VXNlckVtYWlscyA9IGFzeW5jICgpID0+IHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHMgPT09IHRydWUgfHwgKHR5cGVvZiB0aGlzLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzID09PSAnZnVuY3Rpb24nICYmIGF3YWl0IFByb21pc2UucmVzb2x2ZSh0aGlzLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzKHJlcXVlc3QpKSA9PT0gdHJ1ZSk7XG4gICAgY29uc3QgcHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCA9IGFzeW5jICgpID0+IHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPT09IHRydWUgfHwgKHR5cGVvZiB0aGlzLmNvbmZpZy5wcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID09PSAnZnVuY3Rpb24nICYmIGF3YWl0IFByb21pc2UucmVzb2x2ZSh0aGlzLmNvbmZpZy5wcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsKHJlcXVlc3QpKSA9PT0gdHJ1ZSk7XG4gICAgLy8gSWYgdmVyaWZpY2F0aW9uIGlzIHJlcXVpcmVkXG4gICAgaWYgKGF3YWl0IHZlcmlmeVVzZXJFbWFpbHMoKSAmJiBhd2FpdCBwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsKCkpIHtcbiAgICAgIHRoaXMuc3RvcmFnZS5yZWplY3RTaWdudXAgPSB0cnVlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW4oKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY3JlYXRlU2Vzc2lvblRva2VuID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICAvLyBjbG91ZCBpbnN0YWxsYXRpb25JZCBmcm9tIENsb3VkIENvZGUsXG4gIC8vIG5ldmVyIGNyZWF0ZSBzZXNzaW9uIHRva2VucyBmcm9tIHRoZXJlLlxuICBpZiAodGhpcy5hdXRoLmluc3RhbGxhdGlvbklkICYmIHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCA9PT0gJ2Nsb3VkJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyID09IG51bGwgJiYgdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkuam9pbignLCcpO1xuICAgIC8vIEludmFsaWRhdGUgY2FjaGVkIGNyZWF0ZWRXaXRoIHNpbmNlIGF1dGhQcm92aWRlciB3YXMganVzdCByZXNvbHZlZFxuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2UuY3JlYXRlZFdpdGg7XG4gIH1cblxuICBjb25zdCBjcmVhdGVkV2l0aCA9IHRoaXMuZ2V0Q3JlYXRlZFdpdGgoKTtcbiAgY29uc3QgeyBzZXNzaW9uRGF0YSwgY3JlYXRlU2Vzc2lvbiB9ID0gUmVzdFdyaXRlLmNyZWF0ZVNlc3Npb24odGhpcy5jb25maWcsIHtcbiAgICB1c2VySWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICBjcmVhdGVkV2l0aCxcbiAgICBpbnN0YWxsYXRpb25JZDogdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkLFxuICB9KTtcblxuICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5zZXNzaW9uVG9rZW4gPSBzZXNzaW9uRGF0YS5zZXNzaW9uVG9rZW47XG4gIH1cblxuICByZXR1cm4gY3JlYXRlU2Vzc2lvbigpO1xufTtcblxuUmVzdFdyaXRlLmNyZWF0ZVNlc3Npb24gPSBmdW5jdGlvbiAoXG4gIGNvbmZpZyxcbiAgeyB1c2VySWQsIGNyZWF0ZWRXaXRoLCBpbnN0YWxsYXRpb25JZCwgYWRkaXRpb25hbFNlc3Npb25EYXRhIH1cbikge1xuICBjb25zdCB0b2tlbiA9ICdyOicgKyBjcnlwdG9VdGlscy5uZXdUb2tlbigpO1xuICBjb25zdCBleHBpcmVzQXQgPSBjb25maWcuZ2VuZXJhdGVTZXNzaW9uRXhwaXJlc0F0KCk7XG4gIGNvbnN0IHNlc3Npb25EYXRhID0ge1xuICAgIHNlc3Npb25Ub2tlbjogdG9rZW4sXG4gICAgdXNlcjoge1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICBvYmplY3RJZDogdXNlcklkLFxuICAgIH0sXG4gICAgY3JlYXRlZFdpdGgsXG4gICAgZXhwaXJlc0F0OiBQYXJzZS5fZW5jb2RlKGV4cGlyZXNBdCksXG4gIH07XG5cbiAgaWYgKGluc3RhbGxhdGlvbklkKSB7XG4gICAgc2Vzc2lvbkRhdGEuaW5zdGFsbGF0aW9uSWQgPSBpbnN0YWxsYXRpb25JZDtcbiAgfVxuXG4gIE9iamVjdC5hc3NpZ24oc2Vzc2lvbkRhdGEsIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzZXNzaW9uRGF0YSxcbiAgICBjcmVhdGVTZXNzaW9uOiAoKSA9PlxuICAgICAgbmV3IFJlc3RXcml0ZShjb25maWcsIEF1dGgubWFzdGVyKGNvbmZpZyksICdfU2Vzc2lvbicsIG51bGwsIHNlc3Npb25EYXRhKS5leGVjdXRlKCksXG4gIH07XG59O1xuXG4vLyBEZWxldGUgZW1haWwgcmVzZXQgdG9rZW5zIGlmIHVzZXIgaXMgY2hhbmdpbmcgcGFzc3dvcmQgb3IgZW1haWwuXG5SZXN0V3JpdGUucHJvdG90eXBlLmRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicgfHwgdGhpcy5xdWVyeSA9PT0gbnVsbCkge1xuICAgIC8vIG51bGwgcXVlcnkgbWVhbnMgY3JlYXRlXG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCdwYXNzd29yZCcgaW4gdGhpcy5kYXRhIHx8ICdlbWFpbCcgaW4gdGhpcy5kYXRhKSB7XG4gICAgY29uc3QgYWRkT3BzID0ge1xuICAgICAgX3BlcmlzaGFibGVfdG9rZW46IHsgX19vcDogJ0RlbGV0ZScgfSxcbiAgICAgIF9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQ6IHsgX19vcDogJ0RlbGV0ZScgfSxcbiAgICB9O1xuICAgIHRoaXMuZGF0YSA9IE9iamVjdC5hc3NpZ24odGhpcy5kYXRhLCBhZGRPcHMpO1xuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIE9ubHkgZm9yIF9TZXNzaW9uLCBhbmQgYXQgY3JlYXRpb24gdGltZVxuICBpZiAodGhpcy5jbGFzc05hbWUgIT0gJ19TZXNzaW9uJyB8fCB0aGlzLnF1ZXJ5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERlc3Ryb3kgdGhlIHNlc3Npb25zIGluICdCYWNrZ3JvdW5kJ1xuICBjb25zdCB7IHVzZXIsIGluc3RhbGxhdGlvbklkLCBzZXNzaW9uVG9rZW4gfSA9IHRoaXMuZGF0YTtcbiAgaWYgKCF1c2VyIHx8ICFpbnN0YWxsYXRpb25JZCkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXVzZXIub2JqZWN0SWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koXG4gICAgJ19TZXNzaW9uJyxcbiAgICB7XG4gICAgICB1c2VyLFxuICAgICAgaW5zdGFsbGF0aW9uSWQsXG4gICAgICBzZXNzaW9uVG9rZW46IHsgJG5lOiBzZXNzaW9uVG9rZW4gfSxcbiAgICB9LFxuICAgIHt9LFxuICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICkuY2F0Y2goZSA9PiB7XG4gICAgaWYgKGUuY29kZSAhPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH0pO1xufTtcblxuLy8gSGFuZGxlcyBhbnkgZm9sbG93dXAgbG9naWNcblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlRm9sbG93dXAgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ10gJiYgdGhpcy5jb25maWcucmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCkge1xuICAgIHZhciBzZXNzaW9uUXVlcnkgPSB7XG4gICAgICB1c2VyOiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICB9LFxuICAgIH07XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddO1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmRlc3Ryb3koJ19TZXNzaW9uJywgc2Vzc2lvblF1ZXJ5KVxuICAgICAgLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddO1xuICAgIHJldHVybiB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbigpLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydzZW5kVmVyaWZpY2F0aW9uRW1haWwnXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddO1xuICAgIC8vIEZpcmUgYW5kIGZvcmdldCFcbiAgICB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZW5kVmVyaWZpY2F0aW9uRW1haWwodGhpcy5kYXRhLCB7IGF1dGg6IHRoaXMuYXV0aCB9KTtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfU2Vzc2lvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIF9TZXNzaW9uIG9iamVjdC5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlU2Vzc2lvbiA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5jbGFzc05hbWUgIT09ICdfU2Vzc2lvbicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIXRoaXMuYXV0aC51c2VyICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTiwgJ1Nlc3Npb24gdG9rZW4gcmVxdWlyZWQuJyk7XG4gIH1cblxuICAvLyBUT0RPOiBWZXJpZnkgcHJvcGVyIGVycm9yIHRvIHRocm93XG4gIGlmICgnQUNMJyBpbiB0aGlzLmRhdGEpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0Nhbm5vdCBzZXQgJyArICdBQ0wgb24gYSBTZXNzaW9uLicpO1xuICB9XG5cbiAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICBpZiAoJ3VzZXInIGluIHRoaXMuZGF0YSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmIHRoaXMuZGF0YS51c2VyPy5vYmplY3RJZCAhPT0gdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnSW52YWxpZCBrZXkgbmFtZTogdXNlcicpO1xuICAgIH0gZWxzZSBpZiAoJ2luc3RhbGxhdGlvbklkJyBpbiB0aGlzLmRhdGEpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnSW52YWxpZCBrZXkgbmFtZTogaW5zdGFsbGF0aW9uSWQnKTtcbiAgICB9IGVsc2UgaWYgKCdzZXNzaW9uVG9rZW4nIGluIHRoaXMuZGF0YSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdJbnZhbGlkIGtleSBuYW1lOiBzZXNzaW9uVG9rZW4nKTtcbiAgICB9IGVsc2UgaWYgKCdleHBpcmVzQXQnIGluIHRoaXMuZGF0YSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdJbnZhbGlkIGtleSBuYW1lOiBleHBpcmVzQXQnKTtcbiAgICB9IGVsc2UgaWYgKCdjcmVhdGVkV2l0aCcgaW4gdGhpcy5kYXRhICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0ludmFsaWQga2V5IG5hbWU6IGNyZWF0ZWRXaXRoJyk7XG4gICAgfVxuICAgIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgICB0aGlzLnF1ZXJ5ID0ge1xuICAgICAgICAkYW5kOiBbXG4gICAgICAgICAgdGhpcy5xdWVyeSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB1c2VyOiB7XG4gICAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgICAgICAgIG9iamVjdElkOiB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgY29uc3QgYWRkaXRpb25hbFNlc3Npb25EYXRhID0ge307XG4gICAgZm9yICh2YXIga2V5IGluIHRoaXMuZGF0YSkge1xuICAgICAgaWYgKGtleSA9PT0gJ29iamVjdElkJyB8fCBrZXkgPT09ICd1c2VyJyB8fCBrZXkgPT09ICdzZXNzaW9uVG9rZW4nIHx8IGtleSA9PT0gJ2V4cGlyZXNBdCcgfHwga2V5ID09PSAnY3JlYXRlZFdpdGgnKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYWRkaXRpb25hbFNlc3Npb25EYXRhW2tleV0gPSB0aGlzLmRhdGFba2V5XTtcbiAgICB9XG5cbiAgICBjb25zdCB7IHNlc3Npb25EYXRhLCBjcmVhdGVTZXNzaW9uIH0gPSBSZXN0V3JpdGUuY3JlYXRlU2Vzc2lvbih0aGlzLmNvbmZpZywge1xuICAgICAgdXNlcklkOiB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgIGNyZWF0ZWRXaXRoOiB7XG4gICAgICAgIGFjdGlvbjogJ2NyZWF0ZScsXG4gICAgICB9LFxuICAgICAgYWRkaXRpb25hbFNlc3Npb25EYXRhLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKCFyZXN1bHRzLnJlc3BvbnNlKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsICdFcnJvciBjcmVhdGluZyBzZXNzaW9uLicpO1xuICAgICAgfVxuICAgICAgc2Vzc2lvbkRhdGFbJ29iamVjdElkJ10gPSByZXN1bHRzLnJlc3BvbnNlWydvYmplY3RJZCddO1xuICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgc3RhdHVzOiAyMDEsXG4gICAgICAgIGxvY2F0aW9uOiByZXN1bHRzLmxvY2F0aW9uLFxuICAgICAgICByZXNwb25zZTogc2Vzc2lvbkRhdGEsXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfSW5zdGFsbGF0aW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gaW5zdGFsbGF0aW9uIG9iamVjdC5cbi8vIElmIGFuIGluc3RhbGxhdGlvbiBpcyBmb3VuZCwgdGhpcyBjYW4gbXV0YXRlIHRoaXMucXVlcnkgYW5kIHR1cm4gYSBjcmVhdGVcbi8vIGludG8gYW4gdXBkYXRlLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVJbnN0YWxsYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMuY2xhc3NOYW1lICE9PSAnX0luc3RhbGxhdGlvbicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoXG4gICAgIXRoaXMucXVlcnkgJiZcbiAgICAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICF0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgMTM1LFxuICAgICAgJ2F0IGxlYXN0IG9uZSBJRCBmaWVsZCAoZGV2aWNlVG9rZW4sIGluc3RhbGxhdGlvbklkKSAnICsgJ211c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJ1xuICAgICk7XG4gIH1cblxuICAvLyBJZiB0aGUgZGV2aWNlIHRva2VuIGlzIDY0IGNoYXJhY3RlcnMgbG9uZywgd2UgYXNzdW1lIGl0IGlzIGZvciBpT1NcbiAgLy8gYW5kIGxvd2VyY2FzZSBpdC5cbiAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4ubGVuZ3RoID09IDY0KSB7XG4gICAgdGhpcy5kYXRhLmRldmljZVRva2VuID0gdGhpcy5kYXRhLmRldmljZVRva2VuLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBXZSBsb3dlcmNhc2UgdGhlIGluc3RhbGxhdGlvbklkIGlmIHByZXNlbnRcbiAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCA9IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZC50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgbGV0IGluc3RhbGxhdGlvbklkID0gdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkO1xuXG4gIC8vIElmIGRhdGEuaW5zdGFsbGF0aW9uSWQgaXMgbm90IHNldCBhbmQgd2UncmUgbm90IG1hc3Rlciwgd2UgY2FuIGxvb2t1cCBpbiBhdXRoXG4gIGlmICghaW5zdGFsbGF0aW9uSWQgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICBpbnN0YWxsYXRpb25JZCA9IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuXG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIGluc3RhbGxhdGlvbklkID0gaW5zdGFsbGF0aW9uSWQudG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIC8vIFVwZGF0aW5nIF9JbnN0YWxsYXRpb24gYnV0IG5vdCB1cGRhdGluZyBhbnl0aGluZyBjcml0aWNhbFxuICBpZiAodGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmICFpbnN0YWxsYXRpb25JZCAmJiAhdGhpcy5kYXRhLmRldmljZVR5cGUpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4gIHZhciBpZE1hdGNoOyAvLyBXaWxsIGJlIGEgbWF0Y2ggb24gZWl0aGVyIG9iamVjdElkIG9yIGluc3RhbGxhdGlvbklkXG4gIHZhciBvYmplY3RJZE1hdGNoO1xuICB2YXIgaW5zdGFsbGF0aW9uSWRNYXRjaDtcbiAgdmFyIGRldmljZVRva2VuTWF0Y2hlcyA9IFtdO1xuXG4gIC8vIEluc3RlYWQgb2YgaXNzdWluZyAzIHJlYWRzLCBsZXQncyBkbyBpdCB3aXRoIG9uZSBPUi5cbiAgY29uc3Qgb3JRdWVyaWVzID0gW107XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBvYmplY3RJZDogdGhpcy5xdWVyeS5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBpbnN0YWxsYXRpb25JZDogaW5zdGFsbGF0aW9uSWQsXG4gICAgfSk7XG4gIH1cbiAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgIG9yUXVlcmllcy5wdXNoKHsgZGV2aWNlVG9rZW46IHRoaXMuZGF0YS5kZXZpY2VUb2tlbiB9KTtcbiAgfVxuXG4gIGlmIChvclF1ZXJpZXMubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBwcm9taXNlID0gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAnX0luc3RhbGxhdGlvbicsXG4gICAgICAgIHtcbiAgICAgICAgICAkb3I6IG9yUXVlcmllcyxcbiAgICAgICAgfSxcbiAgICAgICAge31cbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMuZm9yRWFjaChyZXN1bHQgPT4ge1xuICAgICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIHJlc3VsdC5vYmplY3RJZCA9PSB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgb2JqZWN0SWRNYXRjaCA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVzdWx0Lmluc3RhbGxhdGlvbklkID09IGluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgICAgaW5zdGFsbGF0aW9uSWRNYXRjaCA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVzdWx0LmRldmljZVRva2VuID09IHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgICAgICAgIGRldmljZVRva2VuTWF0Y2hlcy5wdXNoKHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICAvLyBTYW5pdHkgY2hlY2tzIHdoZW4gcnVubmluZyBhIHF1ZXJ5XG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgIGlmICghb2JqZWN0SWRNYXRjaCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZCBmb3IgdXBkYXRlLicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICBvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICE9PSBvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsICdpbnN0YWxsYXRpb25JZCBtYXkgbm90IGJlIGNoYW5nZWQgaW4gdGhpcyAnICsgJ29wZXJhdGlvbicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICBvYmplY3RJZE1hdGNoLmRldmljZVRva2VuICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICE9PSBvYmplY3RJZE1hdGNoLmRldmljZVRva2VuICYmXG4gICAgICAgICAgIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgICFvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsICdkZXZpY2VUb2tlbiBtYXkgbm90IGJlIGNoYW5nZWQgaW4gdGhpcyAnICsgJ29wZXJhdGlvbicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgIT09IG9iamVjdElkTWF0Y2guZGV2aWNlVHlwZVxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM2LCAnZGV2aWNlVHlwZSBtYXkgbm90IGJlIGNoYW5nZWQgaW4gdGhpcyAnICsgJ29wZXJhdGlvbicpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQgJiYgb2JqZWN0SWRNYXRjaCkge1xuICAgICAgICBpZE1hdGNoID0gb2JqZWN0SWRNYXRjaDtcbiAgICAgIH1cblxuICAgICAgaWYgKGluc3RhbGxhdGlvbklkICYmIGluc3RhbGxhdGlvbklkTWF0Y2gpIHtcbiAgICAgICAgaWRNYXRjaCA9IGluc3RhbGxhdGlvbklkTWF0Y2g7XG4gICAgICB9XG4gICAgICAvLyBuZWVkIHRvIHNwZWNpZnkgZGV2aWNlVHlwZSBvbmx5IGlmIGl0J3MgbmV3XG4gICAgICBpZiAoIXRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5kZXZpY2VUeXBlICYmICFpZE1hdGNoKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzUsICdkZXZpY2VUeXBlIG11c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJyk7XG4gICAgICB9XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICBpZiAoIWlkTWF0Y2gpIHtcbiAgICAgICAgaWYgKCFkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIGRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGggPT0gMSAmJlxuICAgICAgICAgICghZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydpbnN0YWxsYXRpb25JZCddIHx8ICFpbnN0YWxsYXRpb25JZClcbiAgICAgICAgKSB7XG4gICAgICAgICAgLy8gU2luZ2xlIG1hdGNoIG9uIGRldmljZSB0b2tlbiBidXQgbm9uZSBvbiBpbnN0YWxsYXRpb25JZCwgYW5kIGVpdGhlclxuICAgICAgICAgIC8vIHRoZSBwYXNzZWQgb2JqZWN0IG9yIHRoZSBtYXRjaCBpcyBtaXNzaW5nIGFuIGluc3RhbGxhdGlvbklkLCBzbyB3ZVxuICAgICAgICAgIC8vIGNhbiBqdXN0IHJldHVybiB0aGUgbWF0Y2guXG4gICAgICAgICAgcmV0dXJuIGRldmljZVRva2VuTWF0Y2hlc1swXVsnb2JqZWN0SWQnXTtcbiAgICAgICAgfSBlbHNlIGlmICghdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgMTMyLFxuICAgICAgICAgICAgJ011c3Qgc3BlY2lmeSBpbnN0YWxsYXRpb25JZCB3aGVuIGRldmljZVRva2VuICcgK1xuICAgICAgICAgICAgICAnbWF0Y2hlcyBtdWx0aXBsZSBJbnN0YWxsYXRpb24gb2JqZWN0cydcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIE11bHRpcGxlIGRldmljZSB0b2tlbiBtYXRjaGVzIGFuZCB3ZSBzcGVjaWZpZWQgYW4gaW5zdGFsbGF0aW9uIElELFxuICAgICAgICAgIC8vIG9yIGEgc2luZ2xlIG1hdGNoIHdoZXJlIGJvdGggdGhlIHBhc3NlZCBhbmQgbWF0Y2hpbmcgb2JqZWN0cyBoYXZlXG4gICAgICAgICAgLy8gYW4gaW5zdGFsbGF0aW9uIElELiBDbGVhbiBvdXQgb3RoZXIgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoIHRoZVxuICAgICAgICAgIC8vIGRldmljZVRva2VuLCBhbmQgcmV0dXJuIG5pbCB0byBzaWduYWwgdGhhdCBhIG5ldyBvYmplY3Qgc2hvdWxkIGJlXG4gICAgICAgICAgLy8gY3JlYXRlZC5cbiAgICAgICAgICBjb25zdCBkZWxRdWVyeSA9IHtcbiAgICAgICAgICAgIGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4sXG4gICAgICAgICAgICBpbnN0YWxsYXRpb25JZDoge1xuICAgICAgICAgICAgICAkbmU6IGluc3RhbGxhdGlvbklkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9O1xuICAgICAgICAgIGlmICh0aGlzLmRhdGEuYXBwSWRlbnRpZmllcikge1xuICAgICAgICAgICAgZGVsUXVlcnlbJ2FwcElkZW50aWZpZXInXSA9IHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBpbnN0YWxsYXRpb25PcHRzID0gdGhpcy5jb25maWcuaW5zdGFsbGF0aW9uIHx8IHt9O1xuICAgICAgICAgIHJldHVybiBJbnN0YWxsYXRpb25EZWR1cC5yZW1vdmVDb25mbGljdGluZ0RldmljZVRva2VuKHtcbiAgICAgICAgICAgIGRhdGFiYXNlOiB0aGlzLmNvbmZpZy5kYXRhYmFzZSxcbiAgICAgICAgICAgIHF1ZXJ5OiBkZWxRdWVyeSxcbiAgICAgICAgICAgIGFjdGlvbjogaW5zdGFsbGF0aW9uT3B0cy5kdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbiB8fCAnZGVsZXRlJyxcbiAgICAgICAgICAgIGVuZm9yY2VBdXRoOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGggPT09IHRydWUsXG4gICAgICAgICAgICBydW5PcHRpb25zOiB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmICFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ10pIHtcbiAgICAgICAgICAvLyBFeGFjdGx5IG9uZSBkZXZpY2UgdG9rZW4gbWF0Y2ggYW5kIGl0IGRvZXNuJ3QgaGF2ZSBhbiBpbnN0YWxsYXRpb25cbiAgICAgICAgICAvLyBJRC4gVGhlIHR3byByb3dzIHJlcHJlc2VudCB0aGUgc2FtZSBpbnN0YWxsOyByZXNvbHZlIHRoZSBtZXJnZSBwZXJcbiAgICAgICAgICAvLyB0aGUgY29uZmlndXJlZCBvcHRpb25zLlxuICAgICAgICAgIGNvbnN0IGluc3RhbGxhdGlvbk9wdHMgPSB0aGlzLmNvbmZpZy5pbnN0YWxsYXRpb24gfHwge307XG4gICAgICAgICAgcmV0dXJuIEluc3RhbGxhdGlvbkRlZHVwLmFwcGx5RHVwbGljYXRlRGV2aWNlVG9rZW5NZXJnZSh7XG4gICAgICAgICAgICBkYXRhYmFzZTogdGhpcy5jb25maWcuZGF0YWJhc2UsXG4gICAgICAgICAgICBpZE1hdGNoLFxuICAgICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaDogZGV2aWNlVG9rZW5NYXRjaGVzWzBdLFxuICAgICAgICAgICAgYWN0aW9uOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uIHx8ICdkZWxldGUnLFxuICAgICAgICAgICAgbWVyZ2VQcmlvcml0eTogaW5zdGFsbGF0aW9uT3B0cy5kdXBsaWNhdGVEZXZpY2VUb2tlbk1lcmdlUHJpb3JpdHkgfHwgJ2RldmljZVRva2VuJyxcbiAgICAgICAgICAgIGVuZm9yY2VBdXRoOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGggPT09IHRydWUsXG4gICAgICAgICAgICBydW5PcHRpb25zOiB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiYgaWRNYXRjaC5kZXZpY2VUb2tlbiAhPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICAgICAgICAgIC8vIFdlJ3JlIHNldHRpbmcgdGhlIGRldmljZSB0b2tlbiBvbiBhbiBleGlzdGluZyBpbnN0YWxsYXRpb24sIHNvXG4gICAgICAgICAgICAvLyB3ZSBzaG91bGQgdHJ5IGNsZWFuaW5nIG91dCBvbGQgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoIHRoaXNcbiAgICAgICAgICAgIC8vIGRldmljZSB0b2tlbi5cbiAgICAgICAgICAgIGNvbnN0IGRlbFF1ZXJ5ID0ge1xuICAgICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIC8vIFdlIGhhdmUgYSB1bmlxdWUgaW5zdGFsbCBJZCwgdXNlIHRoYXQgdG8gcHJlc2VydmVcbiAgICAgICAgICAgIC8vIHRoZSBpbnRlcmVzdGluZyBpbnN0YWxsYXRpb25cbiAgICAgICAgICAgIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ2luc3RhbGxhdGlvbklkJ10gPSB7XG4gICAgICAgICAgICAgICAgJG5lOiB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCAmJlxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkID09IHRoaXMuZGF0YS5vYmplY3RJZFxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIC8vIHdlIHBhc3NlZCBhbiBvYmplY3RJZCwgcHJlc2VydmUgdGhhdCBpbnN0YWxhdGlvblxuICAgICAgICAgICAgICBkZWxRdWVyeVsnb2JqZWN0SWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IGlkTWF0Y2gub2JqZWN0SWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBXaGF0IHRvIGRvIGhlcmU/IGNhbid0IHJlYWxseSBjbGVhbiB1cCBldmVyeXRoaW5nLi4uXG4gICAgICAgICAgICAgIHJldHVybiBpZE1hdGNoLm9iamVjdElkO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyKSB7XG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGluc3RhbGxhdGlvbk9wdHMgPSB0aGlzLmNvbmZpZy5pbnN0YWxsYXRpb24gfHwge307XG4gICAgICAgICAgICByZXR1cm4gSW5zdGFsbGF0aW9uRGVkdXAucmVtb3ZlQ29uZmxpY3RpbmdEZXZpY2VUb2tlbih7XG4gICAgICAgICAgICAgIGRhdGFiYXNlOiB0aGlzLmNvbmZpZy5kYXRhYmFzZSxcbiAgICAgICAgICAgICAgcXVlcnk6IGRlbFF1ZXJ5LFxuICAgICAgICAgICAgICBhY3Rpb246IGluc3RhbGxhdGlvbk9wdHMuZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24gfHwgJ2RlbGV0ZScsXG4gICAgICAgICAgICAgIGVuZm9yY2VBdXRoOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGggPT09IHRydWUsXG4gICAgICAgICAgICAgIHJ1bk9wdGlvbnM6IHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICAgICAgdmFsaWRTY2hlbWFDb250cm9sbGVyOiB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgIH0pLnRoZW4oKCkgPT4gaWRNYXRjaC5vYmplY3RJZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEluIG5vbi1tZXJnZSBzY2VuYXJpb3MsIGp1c3QgcmV0dXJuIHRoZSBpbnN0YWxsYXRpb24gbWF0Y2ggaWRcbiAgICAgICAgICByZXR1cm4gaWRNYXRjaC5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4ob2JqSWQgPT4ge1xuICAgICAgaWYgKG9iaklkKSB7XG4gICAgICAgIHRoaXMucXVlcnkgPSB7IG9iamVjdElkOiBvYmpJZCB9O1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcbiAgICAgIH1cbiAgICAgIC8vIFRPRE86IFZhbGlkYXRlIG9wcyAoYWRkL3JlbW92ZSBvbiBjaGFubmVscywgJGluYyBvbiBiYWRnZSwgZXRjLilcbiAgICB9KTtcbiAgcmV0dXJuIHByb21pc2U7XG59O1xuXG4vLyBJZiB3ZSBzaG9ydC1jaXJjdWl0ZWQgdGhlIG9iamVjdCByZXNwb25zZSAtIHRoZW4gd2UgbmVlZCB0byBtYWtlIHN1cmUgd2UgZXhwYW5kIGFsbCB0aGUgZmlsZXMsXG4vLyBzaW5jZSB0aGlzIG1pZ2h0IG5vdCBoYXZlIGEgcXVlcnksIG1lYW5pbmcgaXQgd29uJ3QgcmV0dXJuIHRoZSBmdWxsIHJlc3VsdCBiYWNrLlxuLy8gVE9ETzogKG5sdXRzZW5rbykgVGhpcyBzaG91bGQgZGllIHdoZW4gd2UgbW92ZSB0byBwZXItY2xhc3MgYmFzZWQgY29udHJvbGxlcnMgb24gX1Nlc3Npb24vX1VzZXJcblJlc3RXcml0ZS5wcm90b3R5cGUuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIC8vIENoZWNrIHdoZXRoZXIgd2UgaGF2ZSBhIHNob3J0LWNpcmN1aXRlZCByZXNwb25zZSAtIG9ubHkgdGhlbiBydW4gZXhwYW5zaW9uLlxuICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgYXdhaXQgdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QodGhpcy5jb25maWcsIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpO1xuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkRhdGFiYXNlT3BlcmF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Sb2xlJykge1xuICAgIGlmICh0aGlzLmRhdGEgJiYgdGhpcy5kYXRhLnVzZXJzICYmIHRoaXMuZGF0YS51c2Vycy5vYmplY3RzKSB7XG4gICAgICB0aGlzLmRhdGEudXNlcnMub2JqZWN0cy5mb3JFYWNoKCh7IG9iamVjdElkIH0pID0+IHtcbiAgICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnJvbGUuZGVsKG9iamVjdElkKTtcbiAgICAgICAgaWYgKHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIpIHtcbiAgICAgICAgICB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLmNsZWFyQ2FjaGVkUm9sZXMoUGFyc2UuVXNlci5jcmVhdGVXaXRob3V0RGF0YShvYmplY3RJZCkpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnJvbGUuY2xlYXIoKTtcbiAgICAgIGlmICh0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyKSB7XG4gICAgICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIuY2xlYXJDYWNoZWRSb2xlcyh0aGlzLmF1dGgudXNlcik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmIHRoaXMucXVlcnkgJiYgdGhpcy5hdXRoLmlzVW5hdXRoZW50aWNhdGVkKCkpIHtcbiAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLlNFU1NJT05fTUlTU0lORyxcbiAgICAgIGBDYW5ub3QgbW9kaWZ5IHVzZXIgJHt0aGlzLnF1ZXJ5Lm9iamVjdElkfS5gLFxuICAgICAgdGhpcy5jb25maWdcbiAgICApO1xuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1Byb2R1Y3QnICYmIHRoaXMuZGF0YS5kb3dubG9hZCkge1xuICAgIHRoaXMuZGF0YS5kb3dubG9hZE5hbWUgPSB0aGlzLmRhdGEuZG93bmxvYWQubmFtZTtcbiAgfVxuXG4gIC8vIFRPRE86IEFkZCBiZXR0ZXIgZGV0ZWN0aW9uIGZvciBBQ0wsIGVuc3VyaW5nIGEgdXNlciBjYW4ndCBiZSBsb2NrZWQgZnJvbVxuICAvLyAgICAgICB0aGVpciBvd24gdXNlciByZWNvcmQuXG4gIGlmICh0aGlzLmRhdGEuQUNMICYmIHRoaXMuZGF0YS5BQ0xbJyp1bnJlc29sdmVkJ10pIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9BQ0wsICdJbnZhbGlkIEFDTC4nKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgLy8gRm9yY2UgdGhlIHVzZXIgdG8gbm90IGxvY2tvdXRcbiAgICAvLyBNYXRjaGVkIHdpdGggcGFyc2UuY29tXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5BQ0wgJiZcbiAgICAgIHRoaXMuYXV0aC5pc01hc3RlciAhPT0gdHJ1ZSAmJlxuICAgICAgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UgIT09IHRydWVcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5BQ0xbdGhpcy5xdWVyeS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgfVxuICAgIC8vIHVwZGF0ZSBwYXNzd29yZCB0aW1lc3RhbXAgaWYgdXNlciBwYXNzd29yZCBpcyBiZWluZyBjaGFuZ2VkXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2VcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSk7XG4gICAgfVxuICAgIC8vIElnbm9yZSBjcmVhdGVkQXQgd2hlbiB1cGRhdGVcbiAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcblxuICAgIGxldCBkZWZlciA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIC8vIGlmIHBhc3N3b3JkIGhpc3RvcnkgaXMgZW5hYmxlZCB0aGVuIHNhdmUgdGhlIGN1cnJlbnQgcGFzc3dvcmQgdG8gaGlzdG9yeVxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeVxuICAgICkge1xuICAgICAgZGVmZXIgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAuZmluZChcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICAgIHsga2V5czogWydfcGFzc3dvcmRfaGlzdG9yeScsICdfaGFzaGVkX3Bhc3N3b3JkJ10gfSxcbiAgICAgICAgICBBdXRoLm1haW50ZW5hbmNlKHRoaXMuY29uZmlnKVxuICAgICAgICApXG4gICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICAgIGxldCBvbGRQYXNzd29yZHMgPSBbXTtcbiAgICAgICAgICBpZiAodXNlci5fcGFzc3dvcmRfaGlzdG9yeSkge1xuICAgICAgICAgICAgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgICAgICB1c2VyLl9wYXNzd29yZF9oaXN0b3J5LFxuICAgICAgICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnlcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vbi0xIHBhc3N3b3JkcyBnbyBpbnRvIGhpc3RvcnkgaW5jbHVkaW5nIGxhc3QgcGFzc3dvcmRcbiAgICAgICAgICB3aGlsZSAoXG4gICAgICAgICAgICBvbGRQYXNzd29yZHMubGVuZ3RoID4gTWF0aC5tYXgoMCwgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5IC0gMilcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIG9sZFBhc3N3b3Jkcy5zaGlmdCgpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvbGRQYXNzd29yZHMucHVzaCh1c2VyLnBhc3N3b3JkKTtcbiAgICAgICAgICB0aGlzLmRhdGEuX3Bhc3N3b3JkX2hpc3RvcnkgPSBvbGRQYXNzd29yZHM7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBkZWZlci50aGVuKCgpID0+IHtcbiAgICAgIC8vIFJ1biBhbiB1cGRhdGVcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAudXBkYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgICAgICApXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgdGhpcy5fdGhyb3dJZkF1dGhEYXRhRHVwbGljYXRlKGVycm9yKTtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgICAgIHJlc3BvbnNlLnVwZGF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEocmVzcG9uc2UsIHRoaXMuZGF0YSk7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZSA9IHsgcmVzcG9uc2UgfTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgLy8gU2V0IHRoZSBkZWZhdWx0IEFDTCBhbmQgcGFzc3dvcmQgdGltZXN0YW1wIGZvciB0aGUgbmV3IF9Vc2VyXG4gICAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICB2YXIgQUNMID0gdGhpcy5kYXRhLkFDTDtcbiAgICAgIC8vIGRlZmF1bHQgcHVibGljIHIvdyBBQ0xcbiAgICAgIGlmICghQUNMKSB7XG4gICAgICAgIEFDTCA9IHt9O1xuICAgICAgICBpZiAoIXRoaXMuY29uZmlnLmVuZm9yY2VQcml2YXRlVXNlcnMpIHtcbiAgICAgICAgICBBQ0xbJyonXSA9IHsgcmVhZDogdHJ1ZSwgd3JpdGU6IGZhbHNlIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIG1ha2Ugc3VyZSB0aGUgdXNlciBpcyBub3QgbG9ja2VkIGRvd25cbiAgICAgIEFDTFt0aGlzLmRhdGEub2JqZWN0SWRdID0geyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9O1xuICAgICAgdGhpcy5kYXRhLkFDTCA9IEFDTDtcbiAgICAgIC8vIHBhc3N3b3JkIHRpbWVzdGFtcCB0byBiZSB1c2VkIHdoZW4gcGFzc3dvcmQgZXhwaXJ5IHBvbGljeSBpcyBlbmZvcmNlZFxuICAgICAgaWYgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlKSB7XG4gICAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUnVuIGEgY3JlYXRlXG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuY3JlYXRlKHRoaXMuY2xhc3NOYW1lLCB0aGlzLmRhdGEsIHRoaXMucnVuT3B0aW9ucywgZmFsc2UsIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IGVycm9yLmNvZGUgIT09IFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSkge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5fdGhyb3dJZkF1dGhEYXRhRHVwbGljYXRlKGVycm9yKTtcblxuICAgICAgICAvLyBRdWljayBjaGVjaywgaWYgd2Ugd2VyZSBhYmxlIHRvIGluZmVyIHRoZSBkdXBsaWNhdGVkIGZpZWxkIG5hbWVcbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnVzZXJJbmZvICYmIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICd1c2VybmFtZScpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnVzZXJJbmZvICYmIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICdlbWFpbCcpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB0aGlzIHdhcyBhIGZhaWxlZCB1c2VyIGNyZWF0aW9uIGR1ZSB0byB1c2VybmFtZSBvciBlbWFpbCBhbHJlYWR5IHRha2VuLCB3ZSBuZWVkIHRvXG4gICAgICAgIC8vIGNoZWNrIHdoZXRoZXIgaXQgd2FzIHVzZXJuYW1lIG9yIGVtYWlsIGFuZCByZXR1cm4gdGhlIGFwcHJvcHJpYXRlIGVycm9yLlxuICAgICAgICAvLyBGYWxsYmFjayB0byB0aGUgb3JpZ2luYWwgbWV0aG9kXG4gICAgICAgIC8vIFRPRE86IFNlZSBpZiB3ZSBjYW4gbGF0ZXIgZG8gdGhpcyB3aXRob3V0IGFkZGl0aW9uYWwgcXVlcmllcyBieSB1c2luZyBuYW1lZCBpbmRleGVzLlxuICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAuZmluZChcbiAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB1c2VybmFtZTogdGhpcy5kYXRhLnVzZXJuYW1lLFxuICAgICAgICAgICAgICBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHsgbGltaXQ6IDEgfVxuICAgICAgICAgIClcbiAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOLFxuICAgICAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgeyBlbWFpbDogdGhpcy5kYXRhLmVtYWlsLCBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9IH0sXG4gICAgICAgICAgICAgIHsgbGltaXQ6IDEgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgcmVzcG9uc2Uub2JqZWN0SWQgPSB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gICAgICAgIHJlc3BvbnNlLmNyZWF0ZWRBdCA9IHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG5cbiAgICAgICAgaWYgKHRoaXMucmVzcG9uc2VTaG91bGRIYXZlVXNlcm5hbWUpIHtcbiAgICAgICAgICByZXNwb25zZS51c2VybmFtZSA9IHRoaXMuZGF0YS51c2VybmFtZTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKHJlc3BvbnNlLCB0aGlzLmRhdGEpO1xuICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICAgIHJlc3BvbnNlLFxuICAgICAgICAgIGxvY2F0aW9uOiB0aGlzLmxvY2F0aW9uKCksXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgfVxufTtcblxuLy8gUmV0dXJucyBub3RoaW5nIC0gZG9lc24ndCB3YWl0IGZvciB0aGUgdHJpZ2dlci5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQWZ0ZXJTYXZlVHJpZ2dlciA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLnJlc3BvbnNlIHx8ICF0aGlzLnJlc3BvbnNlLnJlc3BvbnNlIHx8IHRoaXMucnVuT3B0aW9ucy5tYW55KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYWZ0ZXJTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBjb25zdCBoYXNBZnRlclNhdmVIb29rID0gdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICApO1xuICBjb25zdCBoYXNMaXZlUXVlcnkgPSB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLmhhc0xpdmVRdWVyeSh0aGlzLmNsYXNzTmFtZSk7XG4gIGlmICghaGFzQWZ0ZXJTYXZlSG9vayAmJiAhaGFzTGl2ZVF1ZXJ5KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICB1cGRhdGVkT2JqZWN0Ll9oYW5kbGVTYXZlUmVzcG9uc2UodGhpcy5yZXNwb25zZS5yZXNwb25zZSwgdGhpcy5yZXNwb25zZS5zdGF0dXMgfHwgMjAwKTtcblxuICBpZiAoaGFzTGl2ZVF1ZXJ5KSB7XG4gICAgdGhpcy5jb25maWcuZGF0YWJhc2UubG9hZFNjaGVtYSgpLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICAvLyBOb3RpZnkgTGl2ZVF1ZXJ5U2VydmVyIGlmIHBvc3NpYmxlXG4gICAgICBjb25zdCBwZXJtcyA9IHNjaGVtYUNvbnRyb2xsZXIuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lKTtcbiAgICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIub25BZnRlclNhdmUoXG4gICAgICAgIHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgcGVybXNcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cbiAgaWYgKCFoYXNBZnRlclNhdmVIb29rKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFJ1biBhZnRlclNhdmUgdHJpZ2dlclxuICByZXR1cm4gdHJpZ2dlcnNcbiAgICAubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLFxuICAgICAgdGhpcy5hdXRoLFxuICAgICAgdXBkYXRlZE9iamVjdCxcbiAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLmNvbnRleHRcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgIGNvbnN0IGpzb25SZXR1cm5lZCA9IHJlc3VsdCAmJiAhcmVzdWx0Ll90b0Z1bGxKU09OO1xuICAgICAgaWYgKGpzb25SZXR1cm5lZCkge1xuICAgICAgICB0aGlzLnBlbmRpbmdPcHMub3BlcmF0aW9ucyA9IHt9O1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlID0gcmVzdWx0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZSA9IHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEoXG4gICAgICAgICAgKHJlc3VsdCB8fCB1cGRhdGVkT2JqZWN0KS50b0pTT04oKSxcbiAgICAgICAgICB0aGlzLmRhdGFcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBsb2dnZXIud2FybignYWZ0ZXJTYXZlIGNhdWdodCBhbiBlcnJvcicsIGVycik7XG4gICAgfSk7XG59O1xuXG4vLyBBIGhlbHBlciB0byBmaWd1cmUgb3V0IHdoYXQgbG9jYXRpb24gdGhpcyBvcGVyYXRpb24gaGFwcGVucyBhdC5cblJlc3RXcml0ZS5wcm90b3R5cGUubG9jYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBtaWRkbGUgPSB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyA/ICcvdXNlcnMvJyA6ICcvY2xhc3Nlcy8nICsgdGhpcy5jbGFzc05hbWUgKyAnLyc7XG4gIGNvbnN0IG1vdW50ID0gdGhpcy5jb25maWcubW91bnQgfHwgdGhpcy5jb25maWcuc2VydmVyVVJMO1xuICByZXR1cm4gbW91bnQgKyBtaWRkbGUgKyB0aGlzLmRhdGEub2JqZWN0SWQ7XG59O1xuXG4vLyBBIGhlbHBlciB0byBnZXQgdGhlIG9iamVjdCBpZCBmb3IgdGhpcyBvcGVyYXRpb24uXG4vLyBCZWNhdXNlIGl0IGNvdWxkIGJlIGVpdGhlciBvbiB0aGUgcXVlcnkgb3Igb24gdGhlIGRhdGFcblJlc3RXcml0ZS5wcm90b3R5cGUub2JqZWN0SWQgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLmRhdGEub2JqZWN0SWQgfHwgdGhpcy5xdWVyeS5vYmplY3RJZDtcbn07XG5cbi8vIFJldHVybnMgYSBjb3B5IG9mIHRoZSBkYXRhIGFuZCBkZWxldGUgYmFkIGtleXMgKF9hdXRoX2RhdGEsIF9oYXNoZWRfcGFzc3dvcmQuLi4pXG5SZXN0V3JpdGUucHJvdG90eXBlLnNhbml0aXplZERhdGEgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IGRhdGEgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLnJlZHVjZSgoZGF0YSwga2V5KSA9PiB7XG4gICAgLy8gUmVnZXhwIGNvbWVzIGZyb20gUGFyc2UuT2JqZWN0LnByb3RvdHlwZS52YWxpZGF0ZVxuICAgIGlmICghL15bQS1aYS16XVswLTlBLVphLXpfXSokLy50ZXN0KGtleSkpIHtcbiAgICAgIGRlbGV0ZSBkYXRhW2tleV07XG4gICAgfVxuICAgIHJldHVybiBkYXRhO1xuICB9LCBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5kYXRhKSk7XG4gIHJldHVybiBQYXJzZS5fZGVjb2RlKHVuZGVmaW5lZCwgZGF0YSk7XG59O1xuXG4vLyBSZXR1cm5zIGFuIHVwZGF0ZWQgY29weSBvZiB0aGUgb2JqZWN0XG5SZXN0V3JpdGUucHJvdG90eXBlLmJ1aWxkUGFyc2VPYmplY3RzID0gZnVuY3Rpb24gKCkge1xuICBjb25zdCBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUsIG9iamVjdElkOiB0aGlzLnF1ZXJ5Py5vYmplY3RJZCB9O1xuICBsZXQgb3JpZ2luYWxPYmplY3Q7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvcmlnaW5hbE9iamVjdCA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIH1cblxuICBjb25zdCBjbGFzc05hbWUgPSBQYXJzZS5PYmplY3QuZnJvbUpTT04oZXh0cmFEYXRhKTtcbiAgY29uc3QgcmVhZE9ubHlBdHRyaWJ1dGVzID0gY2xhc3NOYW1lLmNvbnN0cnVjdG9yLnJlYWRPbmx5QXR0cmlidXRlc1xuICAgID8gY2xhc3NOYW1lLmNvbnN0cnVjdG9yLnJlYWRPbmx5QXR0cmlidXRlcygpXG4gICAgOiBbXTtcblxuICAvLyBGb3IgX1JvbGUgY2xhc3MsICduYW1lJyBjYW5ub3QgYmUgc2V0IGFmdGVyIHRoZSByb2xlIGhhcyBhbiBvYmplY3RJZC5cbiAgLy8gSW4gYWZ0ZXJTYXZlIGNvbnRleHQsIF9oYW5kbGVTYXZlUmVzcG9uc2UgaGFzIGFscmVhZHkgc2V0IHRoZSBvYmplY3RJZCxcbiAgLy8gc28gd2UgdHJlYXQgJ25hbWUnIGFzIHJlYWQtb25seSB0byBhdm9pZCBQYXJzZSBTREsgdmFsaWRhdGlvbiBlcnJvcnMuXG4gIGNvbnN0IGlzUm9sZUFmdGVyU2F2ZSA9IHRoaXMuY2xhc3NOYW1lID09PSAnX1JvbGUnICYmIHRoaXMucmVzcG9uc2UgJiYgIXRoaXMucXVlcnk7XG4gIGlmIChpc1JvbGVBZnRlclNhdmUgJiYgdGhpcy5kYXRhLm5hbWUgJiYgIXJlYWRPbmx5QXR0cmlidXRlcy5pbmNsdWRlcygnbmFtZScpKSB7XG4gICAgcmVhZE9ubHlBdHRyaWJ1dGVzLnB1c2goJ25hbWUnKTtcbiAgfVxuICBpZiAoIXRoaXMub3JpZ2luYWxEYXRhKSB7XG4gICAgZm9yIChjb25zdCBhdHRyaWJ1dGUgb2YgcmVhZE9ubHlBdHRyaWJ1dGVzKSB7XG4gICAgICBleHRyYURhdGFbYXR0cmlidXRlXSA9IHRoaXMuZGF0YVthdHRyaWJ1dGVdO1xuICAgIH1cbiAgfVxuICBjb25zdCB1cGRhdGVkT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgT2JqZWN0LmtleXModGhpcy5kYXRhKS5yZWR1Y2UoZnVuY3Rpb24gKGRhdGEsIGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgaWYgKHR5cGVvZiBkYXRhW2tleV0uX19vcCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKCFyZWFkT25seUF0dHJpYnV0ZXMuaW5jbHVkZXMoa2V5KSkge1xuICAgICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KGtleSwgZGF0YVtrZXldKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gc3ViZG9jdW1lbnQga2V5IHdpdGggZG90IG5vdGF0aW9uIHsgJ3gueSc6IHYgfSA9PiB7ICd4JzogeyAneScgOiB2IH0gfSlcbiAgICAgICAgY29uc3Qgc3BsaXR0ZWRLZXkgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgICAgY29uc3QgcGFyZW50UHJvcCA9IHNwbGl0dGVkS2V5WzBdO1xuICAgICAgICBsZXQgcGFyZW50VmFsID0gdXBkYXRlZE9iamVjdC5nZXQocGFyZW50UHJvcCk7XG4gICAgICAgIGlmICh0eXBlb2YgcGFyZW50VmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICAgIHBhcmVudFZhbCA9IHt9O1xuICAgICAgICB9XG4gICAgICAgIHBhcmVudFZhbFtzcGxpdHRlZEtleVsxXV0gPSBkYXRhW2tleV07XG4gICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KHBhcmVudFByb3AsIHBhcmVudFZhbCk7XG4gICAgICB9XG4gICAgICBkZWxldGUgZGF0YVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfSwgc3RydWN0dXJlZENsb25lKHRoaXMuZGF0YSkpO1xuXG4gIGNvbnN0IHNhbml0aXplZCA9IHRoaXMuc2FuaXRpemVkRGF0YSgpO1xuICBmb3IgKGNvbnN0IGF0dHJpYnV0ZSBvZiByZWFkT25seUF0dHJpYnV0ZXMpIHtcbiAgICBkZWxldGUgc2FuaXRpemVkW2F0dHJpYnV0ZV07XG4gIH1cbiAgdXBkYXRlZE9iamVjdC5zZXQoc2FuaXRpemVkKTtcbiAgcmV0dXJuIHsgdXBkYXRlZE9iamVjdCwgb3JpZ2luYWxPYmplY3QgfTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY2xlYW5Vc2VyQXV0aERhdGEgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICBjb25zdCB1c2VyID0gdGhpcy5yZXNwb25zZS5yZXNwb25zZTtcbiAgICBpZiAodXNlci5hdXRoRGF0YSkge1xuICAgICAgT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgIGlmICh1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBpZiAoT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkubGVuZ3RoID09IDApIHtcbiAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGE7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG4vLyBTdHJpcHMgcHJvdGVjdGVkIGZpZWxkcyBmcm9tIHRoZSB3cml0ZSByZXNwb25zZSB3aGVuIHByb3RlY3RlZEZpZWxkc1NhdmVSZXNwb25zZUV4ZW1wdCBpcyBmYWxzZS5cblJlc3RXcml0ZS5wcm90b3R5cGUuZmlsdGVyUHJvdGVjdGVkRmllbGRzSW5SZXNwb25zZSA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY29uZmlnLnByb3RlY3RlZEZpZWxkc1NhdmVSZXNwb25zZUV4ZW1wdCAhPT0gZmFsc2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXRoaXMucmVzcG9uc2UgfHwgIXRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgc2NoZW1hQ29udHJvbGxlciA9IGF3YWl0IHRoaXMuY29uZmlnLmRhdGFiYXNlLmxvYWRTY2hlbWEoKTtcbiAgY29uc3QgcHJvdGVjdGVkRmllbGRzID0gdGhpcy5jb25maWcuZGF0YWJhc2UuYWRkUHJvdGVjdGVkRmllbGRzKFxuICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdGhpcy5xdWVyeSA/IHsgb2JqZWN0SWQ6IHRoaXMucXVlcnkub2JqZWN0SWQgfSA6IHt9LFxuICAgIHRoaXMuYXV0aC51c2VyID8gW3RoaXMuYXV0aC51c2VyLmlkXS5jb25jYXQodGhpcy5hdXRoLnVzZXJSb2xlcyB8fCBbXSkgOiBbXSxcbiAgICB0aGlzLmF1dGgsXG4gICAge31cbiAgKTtcbiAgaWYgKCFwcm90ZWN0ZWRGaWVsZHMpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBmaWVsZCBvZiBwcm90ZWN0ZWRGaWVsZHMpIHtcbiAgICBkZWxldGUgdGhpcy5yZXNwb25zZS5yZXNwb25zZVtmaWVsZF07XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEgPSBmdW5jdGlvbiAocmVzcG9uc2UsIGRhdGEpIHtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKHRoaXMucGVuZGluZ09wcy5pZGVudGlmaWVyKTtcbiAgZm9yIChjb25zdCBrZXkgaW4gdGhpcy5wZW5kaW5nT3BzLm9wZXJhdGlvbnMpIHtcbiAgICBpZiAoIXBlbmRpbmdba2V5XSkge1xuICAgICAgZGF0YVtrZXldID0gdGhpcy5vcmlnaW5hbERhdGEgPyB0aGlzLm9yaWdpbmFsRGF0YVtrZXldIDogeyBfX29wOiAnRGVsZXRlJyB9O1xuICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIucHVzaChrZXkpO1xuICAgIH1cbiAgfVxuICBjb25zdCBza2lwS2V5cyA9IFsuLi4ocmVxdWlyZWRDb2x1bW5zLnJlYWRbdGhpcy5jbGFzc05hbWVdIHx8IFtdKV07XG4gIGlmICghdGhpcy5xdWVyeSkge1xuICAgIHNraXBLZXlzLnB1c2goJ29iamVjdElkJywgJ2NyZWF0ZWRBdCcpO1xuICB9IGVsc2Uge1xuICAgIHNraXBLZXlzLnB1c2goJ3VwZGF0ZWRBdCcpO1xuICAgIGRlbGV0ZSByZXNwb25zZS5vYmplY3RJZDtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBpbiByZXNwb25zZSkge1xuICAgIGlmIChza2lwS2V5cy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgdmFsdWUgPSByZXNwb25zZVtrZXldO1xuICAgIGlmIChcbiAgICAgIHZhbHVlID09IG51bGwgfHxcbiAgICAgICh2YWx1ZS5fX3R5cGUgJiYgdmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKGRhdGFba2V5XSwgdmFsdWUpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKCh0aGlzLm9yaWdpbmFsRGF0YSB8fCB7fSlba2V5XSwgdmFsdWUpXG4gICAgKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2Vba2V5XTtcbiAgICB9XG4gIH1cbiAgaWYgKF8uaXNFbXB0eSh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlcikpIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGNvbnN0IGRhdGFWYWx1ZSA9IGRhdGFbZmllbGROYW1lXTtcblxuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3BvbnNlLCBmaWVsZE5hbWUpKSB7XG4gICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgIH1cblxuICAgIGlmIChyZXNwb25zZVtmaWVsZE5hbWVdICYmIHJlc3BvbnNlW2ZpZWxkTmFtZV0uX19vcCkge1xuICAgICAgZGVsZXRlIHJlc3BvbnNlW2ZpZWxkTmFtZV07XG4gICAgICBpZiAoZGF0YVZhbHVlLl9fb3AgPT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgcmVzcG9uc2VbZmllbGROYW1lXSA9IGRhdGFWYWx1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gcmVzcG9uc2U7XG59O1xuXG5leHBvcnQgZGVmYXVsdCBSZXN0V3JpdGU7XG5tb2R1bGUuZXhwb3J0cyA9IFJlc3RXcml0ZTtcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBYUEsSUFBQUEsVUFBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsT0FBQSxHQUFBRixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUUsT0FBQSxHQUFBSCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUcsaUJBQUEsR0FBQUgsT0FBQTtBQUNBLElBQUFJLE1BQUEsR0FBQUosT0FBQTtBQUNBLElBQUFLLGFBQUEsR0FBQUwsT0FBQTtBQUNBLElBQUFNLGlCQUFBLEdBQUFDLHVCQUFBLENBQUFQLE9BQUE7QUFBeUQsU0FBQU8sd0JBQUFDLENBQUEsRUFBQUMsQ0FBQSw2QkFBQUMsT0FBQSxNQUFBQyxDQUFBLE9BQUFELE9BQUEsSUFBQUUsQ0FBQSxPQUFBRixPQUFBLFlBQUFI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