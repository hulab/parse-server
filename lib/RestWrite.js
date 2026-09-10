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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUmVzdFF1ZXJ5IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9TY2hlbWFDb250cm9sbGVyIiwiX0Vycm9yIiwiX0F1dGhEYXRhTG9jayIsIkluc3RhbGxhdGlvbkRlZHVwIiwiX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQiLCJlIiwidCIsIldlYWtNYXAiLCJyIiwibiIsIl9fZXNNb2R1bGUiLCJvIiwiaSIsImYiLCJfX3Byb3RvX18iLCJkZWZhdWx0IiwiaGFzIiwiZ2V0Iiwic2V0IiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiT2JqZWN0IiwiZGVmaW5lUHJvcGVydHkiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IiLCJTY2hlbWFDb250cm9sbGVyIiwiQXV0aCIsIlV0aWxzIiwiY3J5cHRvVXRpbHMiLCJwYXNzd29yZENyeXB0byIsIlBhcnNlIiwidHJpZ2dlcnMiLCJ1dGlsIiwiUmVzdFdyaXRlIiwiY29uZmlnIiwiYXV0aCIsImNsYXNzTmFtZSIsInF1ZXJ5IiwiZGF0YSIsIm9yaWdpbmFsRGF0YSIsImNvbnRleHQiLCJhY3Rpb24iLCJpc1JlYWRPbmx5IiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJFcnJvciIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJzdG9yYWdlIiwicnVuT3B0aW9ucyIsImFsbG93Q3VzdG9tT2JqZWN0SWQiLCJwcm90b3R5cGUiLCJvYmplY3RJZCIsIk1JU1NJTkdfT0JKRUNUX0lEIiwiSU5WQUxJRF9LRVlfTkFNRSIsImlkIiwicmVzcG9uc2UiLCJzdHJ1Y3R1cmVkQ2xvbmUiLCJ1cGRhdGVkQXQiLCJfZW5jb2RlIiwiRGF0ZSIsImlzbyIsInZhbGlkU2NoZW1hQ29udHJvbGxlciIsInBlbmRpbmdPcHMiLCJvcGVyYXRpb25zIiwiaWRlbnRpZmllciIsImV4ZWN1dGUiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsImhhbmRsZUluc3RhbGxhdGlvbiIsImhhbmRsZVNlc3Npb24iLCJ2YWxpZGF0ZUF1dGhEYXRhIiwiY2hlY2tSZXN0cmljdGVkRmllbGRzIiwicnVuQmVmb3JlU2F2ZVRyaWdnZXIiLCJlbnN1cmVVbmlxdWVBdXRoRGF0YUlkIiwiZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQiLCJ2YWxpZGF0ZVNjaGVtYSIsInNjaGVtYUNvbnRyb2xsZXIiLCJzZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkIiwidmFsaWRhdGVDcmVhdGVQZXJtaXNzaW9uIiwidHJhbnNmb3JtVXNlciIsImV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzIiwiZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucyIsInJ1bkRhdGFiYXNlT3BlcmF0aW9uIiwiY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQiLCJoYW5kbGVGb2xsb3d1cCIsInJ1bkFmdGVyU2F2ZVRyaWdnZXIiLCJjbGVhblVzZXJBdXRoRGF0YSIsImZpbHRlclByb3RlY3RlZEZpZWxkc0luUmVzcG9uc2UiLCJhdXRoRGF0YVJlc3BvbnNlIiwicmVqZWN0U2lnbnVwIiwicHJldmVudFNpZ251cFdpdGhVbnZlcmlmaWVkRW1haWwiLCJFTUFJTF9OT1RfRk9VTkQiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJhY2wiLCJ1c2VyIiwiZ2V0VXNlclJvbGVzIiwicm9sZXMiLCJjb25jYXQiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwiaW5kZXhPZiIsImRhdGFiYXNlIiwibG9hZFNjaGVtYSIsImhhc0NsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJtYW55IiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYmVmb3JlU2F2ZSIsImFwcGxpY2F0aW9uSWQiLCJvcmlnaW5hbE9iamVjdCIsInVwZGF0ZWRPYmplY3QiLCJidWlsZFBhcnNlT2JqZWN0cyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJzdGF0ZUNvbnRyb2xsZXIiLCJDb3JlTWFuYWdlciIsImdldE9iamVjdFN0YXRlQ29udHJvbGxlciIsInBlbmRpbmciLCJnZXRQZW5kaW5nT3BzIiwiZGF0YWJhc2VQcm9taXNlIiwidXBkYXRlIiwiY3JlYXRlIiwicmVzdWx0IiwibGVuZ3RoIiwiT0JKRUNUX05PVF9GT1VORCIsIm1heWJlUnVuVHJpZ2dlciIsIm9iamVjdCIsImZpZWxkc0NoYW5nZWRCeVRyaWdnZXIiLCJfIiwicmVkdWNlIiwidmFsdWUiLCJrZXkiLCJpc0VxdWFsIiwicHVzaCIsImNoZWNrUHJvaGliaXRlZEtleXdvcmRzIiwiZXJyb3IiLCJydW5CZWZvcmVMb2dpblRyaWdnZXIiLCJ1c2VyRGF0YSIsImJlZm9yZUxvZ2luIiwiZXh0cmFEYXRhIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsImluZmxhdGUiLCJnZXRBbGxDbGFzc2VzIiwiYWxsQ2xhc3NlcyIsInNjaGVtYSIsImZpbmQiLCJvbmVDbGFzcyIsInNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCIsImZpZWxkTmFtZSIsInNldERlZmF1bHQiLCJ1bmRlZmluZWQiLCJfX29wIiwiZmllbGRzIiwiZGVmYXVsdFZhbHVlIiwicmVxdWlyZWQiLCJWQUxJREFUSU9OX0VSUk9SIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiQUNMIiwiSlNPTiIsInN0cmluZ2lmeSIsInJlYWQiLCJ3cml0ZSIsImN1cnJlbnRVc2VyIiwiY3JlYXRlZEF0IiwiX190eXBlIiwibmV3T2JqZWN0SWQiLCJvYmplY3RJZFNpemUiLCJrZXlzIiwiZm9yRWFjaCIsImF1dGhEYXRhIiwiaGFzVXNlcm5hbWVBbmRQYXNzd29yZCIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJoYXNBdXRoRGF0YSIsInNvbWUiLCJwcm92aWRlciIsInByb3ZpZGVyRGF0YSIsImlzRW1wdHkiLCJVU0VSTkFNRV9NSVNTSU5HIiwiUEFTU1dPUkRfTUlTU0lORyIsIlVOU1VQUE9SVEVEX1NFUlZJQ0UiLCJwcm92aWRlcnMiLCJjYW5IYW5kbGVBdXRoRGF0YSIsInByb3ZpZGVyQXV0aERhdGEiLCJnZXRVc2VySWQiLCJoYW5kbGVBdXRoRGF0YSIsImZpbHRlcmVkT2JqZWN0c0J5QUNMIiwib2JqZWN0cyIsImZpbHRlciIsIl90aHJvd0lmQXV0aERhdGFEdXBsaWNhdGUiLCJjb2RlIiwiRFVQTElDQVRFX1ZBTFVFIiwidXNlckluZm8iLCJkdXBsaWNhdGVkX2ZpZWxkIiwic3RhcnRzV2l0aCIsIkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQiLCJoYXNBdXRoRGF0YUlkIiwiZmluZFVzZXJzV2l0aEF1dGhEYXRhIiwicmVzdWx0cyIsInVzZXJJZCIsImN1cnJlbnRVc2VyQXV0aERhdGEiLCJ1c2VyUmVzdWx0IiwiZm91bmRVc2VySXNOb3RDdXJyZW50VXNlciIsImhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiIsInZhbGlkYXRlZEF1dGhEYXRhIiwiYXV0aFByb3ZpZGVyIiwiam9pbiIsImhhc011dGF0ZWRBdXRoRGF0YSIsIm11dGF0ZWRBdXRoRGF0YSIsImlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3RlciIsImlzTG9naW4iLCJsb2NhdGlvbiIsImNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4iLCJhbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuIiwicmVzIiwib3JpZ2luYWxBdXRoRGF0YSIsImZyb21FbnRyaWVzIiwiZW50cmllcyIsIm1hcCIsImsiLCJ2IiwiYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrIiwiU0NSSVBUX0ZBSUxFRCIsInZhbGlkYXRlUGVybWlzc2lvbiIsInByb21pc2UiLCJSZXN0UXVlcnkiLCJtZXRob2QiLCJNZXRob2QiLCJtYXN0ZXIiLCJydW5CZWZvcmVGaW5kIiwicmVzdFdoZXJlIiwic2Vzc2lvbiIsImNhY2hlQ29udHJvbGxlciIsImRlbCIsInNlc3Npb25Ub2tlbiIsIl92YWxpZGF0ZVBhc3N3b3JkUG9saWN5IiwiaGFzaCIsImhhc2hlZFBhc3N3b3JkIiwiX2hhc2hlZF9wYXNzd29yZCIsIl92YWxpZGF0ZVVzZXJOYW1lIiwiX3ZhbGlkYXRlRW1haWwiLCJyYW5kb21TdHJpbmciLCJyZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSIsIiRuZSIsImxpbWl0IiwiY2FzZUluc2Vuc2l0aXZlIiwiVVNFUk5BTUVfVEFLRU4iLCJidWlsZENyZWF0ZWRXaXRoIiwiZ2V0Q3JlYXRlZFdpdGgiLCJjcmVhdGVkV2l0aCIsImlzQ3JlYXRlT3BlcmF0aW9uIiwiYXV0aERhdGFQcm92aWRlciIsInJlc29sdmVkQXV0aFByb3ZpZGVyIiwiZW1haWwiLCJtYXRjaCIsInJlamVjdCIsIklOVkFMSURfRU1BSUxfQUREUkVTUyIsIkVNQUlMX1RBS0VOIiwicmVxdWVzdCIsIm9yaWdpbmFsIiwiaXAiLCJpbnN0YWxsYXRpb25JZCIsInVzZXJDb250cm9sbGVyIiwic2V0RW1haWxWZXJpZnlUb2tlbiIsInBhc3N3b3JkUG9saWN5IiwiX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMiLCJfdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkiLCJwb2xpY3lFcnJvciIsInZhbGlkYXRpb25FcnJvciIsImNvbnRhaW5zVXNlcm5hbWVFcnJvciIsInBhdHRlcm5WYWxpZGF0b3IiLCJ2YWxpZGF0b3JDYWxsYmFjayIsImRvTm90QWxsb3dVc2VybmFtZSIsIm1heFBhc3N3b3JkSGlzdG9yeSIsIm1haW50ZW5hbmNlIiwib2xkUGFzc3dvcmRzIiwiX3Bhc3N3b3JkX2hpc3RvcnkiLCJ0YWtlIiwibmV3UGFzc3dvcmQiLCJwcm9taXNlcyIsImNvbXBhcmUiLCJhbGwiLCJjYXRjaCIsImVyciIsInZlcmlmeVVzZXJFbWFpbHMiLCJwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsIiwiY3JlYXRlU2Vzc2lvblRva2VuIiwic2Vzc2lvbkRhdGEiLCJjcmVhdGVTZXNzaW9uIiwiYWRkaXRpb25hbFNlc3Npb25EYXRhIiwidG9rZW4iLCJuZXdUb2tlbiIsImV4cGlyZXNBdCIsImdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCIsImFzc2lnbiIsImFkZE9wcyIsIl9wZXJpc2hhYmxlX3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsImRlc3Ryb3kiLCJyZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0Iiwic2Vzc2lvblF1ZXJ5IiwiYmluZCIsInNlbmRWZXJpZmljYXRpb25FbWFpbCIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsIiRhbmQiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJzdGF0dXMiLCJkZXZpY2VUb2tlbiIsInRvTG93ZXJDYXNlIiwiZGV2aWNlVHlwZSIsImlkTWF0Y2giLCJvYmplY3RJZE1hdGNoIiwiaW5zdGFsbGF0aW9uSWRNYXRjaCIsImRldmljZVRva2VuTWF0Y2hlcyIsIm9yUXVlcmllcyIsIiRvciIsImRlbFF1ZXJ5IiwiYXBwSWRlbnRpZmllciIsImluc3RhbGxhdGlvbk9wdHMiLCJpbnN0YWxsYXRpb24iLCJyZW1vdmVDb25mbGljdGluZ0RldmljZVRva2VuIiwiZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24iLCJlbmZvcmNlQXV0aCIsImR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGgiLCJhcHBseUR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2UiLCJkZXZpY2VUb2tlbk1hdGNoIiwibWVyZ2VQcmlvcml0eSIsImR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2VQcmlvcml0eSIsIm9iaklkIiwidXNlcnMiLCJyb2xlIiwiY2xlYXIiLCJsaXZlUXVlcnlDb250cm9sbGVyIiwiY2xlYXJDYWNoZWRSb2xlcyIsImlzVW5hdXRoZW50aWNhdGVkIiwiU0VTU0lPTl9NSVNTSU5HIiwiZG93bmxvYWQiLCJkb3dubG9hZE5hbWUiLCJuYW1lIiwiSU5WQUxJRF9BQ0wiLCJtYXhQYXNzd29yZEFnZSIsIl9wYXNzd29yZF9jaGFuZ2VkX2F0IiwiZGVmZXIiLCJNYXRoIiwibWF4Iiwic2hpZnQiLCJfdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSIsImVuZm9yY2VQcml2YXRlVXNlcnMiLCJoYXNBZnRlclNhdmVIb29rIiwiYWZ0ZXJTYXZlIiwiaGFzTGl2ZVF1ZXJ5IiwiX2hhbmRsZVNhdmVSZXNwb25zZSIsInBlcm1zIiwiZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zIiwib25BZnRlclNhdmUiLCJqc29uUmV0dXJuZWQiLCJfdG9GdWxsSlNPTiIsInRvSlNPTiIsImxvZ2dlciIsIndhcm4iLCJtaWRkbGUiLCJtb3VudCIsInNlcnZlclVSTCIsInNhbml0aXplZERhdGEiLCJ0ZXN0IiwiX2RlY29kZSIsImZyb21KU09OIiwicmVhZE9ubHlBdHRyaWJ1dGVzIiwiY29uc3RydWN0b3IiLCJpc1JvbGVBZnRlclNhdmUiLCJpbmNsdWRlcyIsImF0dHJpYnV0ZSIsInNwbGl0dGVkS2V5Iiwic3BsaXQiLCJwYXJlbnRQcm9wIiwicGFyZW50VmFsIiwic2FuaXRpemVkIiwicHJvdGVjdGVkRmllbGRzU2F2ZVJlc3BvbnNlRXhlbXB0IiwicHJvdGVjdGVkRmllbGRzIiwiYWRkUHJvdGVjdGVkRmllbGRzIiwidXNlclJvbGVzIiwiZmllbGQiLCJza2lwS2V5cyIsInJlcXVpcmVkQ29sdW1ucyIsImlzRGVlcFN0cmljdEVxdWFsIiwiZGF0YVZhbHVlIiwiX2RlZmF1bHQiLCJleHBvcnRzIiwibW9kdWxlIl0sInNvdXJjZXMiOlsiLi4vc3JjL1Jlc3RXcml0ZS5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBBIFJlc3RXcml0ZSBlbmNhcHN1bGF0ZXMgZXZlcnl0aGluZyB3ZSBuZWVkIHRvIHJ1biBhbiBvcGVyYXRpb25cbi8vIHRoYXQgd3JpdGVzIHRvIHRoZSBkYXRhYmFzZS5cbi8vIFRoaXMgY291bGQgYmUgZWl0aGVyIGEgXCJjcmVhdGVcIiBvciBhbiBcInVwZGF0ZVwiLlxuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xuXG5jb25zdCBBdXRoID0gcmVxdWlyZSgnLi9BdXRoJyk7XG5jb25zdCBVdGlscyA9IHJlcXVpcmUoJy4vVXRpbHMnKTtcbnZhciBjcnlwdG9VdGlscyA9IHJlcXVpcmUoJy4vY3J5cHRvVXRpbHMnKTtcbnZhciBwYXNzd29yZENyeXB0byA9IHJlcXVpcmUoJy4vcGFzc3dvcmQnKTtcbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKTtcbnZhciB0cmlnZ2VycyA9IHJlcXVpcmUoJy4vdHJpZ2dlcnMnKTtcbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5pbXBvcnQgUmVzdFF1ZXJ5IGZyb20gJy4vUmVzdFF1ZXJ5JztcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCB7IHJlcXVpcmVkQ29sdW1ucyB9IGZyb20gJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcic7XG5pbXBvcnQgeyBjcmVhdGVTYW5pdGl6ZWRFcnJvciB9IGZyb20gJy4vRXJyb3InO1xuaW1wb3J0IHsgYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrIH0gZnJvbSAnLi9BdXRoRGF0YUxvY2snO1xuaW1wb3J0ICogYXMgSW5zdGFsbGF0aW9uRGVkdXAgZnJvbSAnLi9JbnN0YWxsYXRpb25EZWR1cCc7XG5cbi8vIHF1ZXJ5IGFuZCBkYXRhIGFyZSBib3RoIHByb3ZpZGVkIGluIFJFU1QgQVBJIGZvcm1hdC4gU28gZGF0YVxuLy8gdHlwZXMgYXJlIGVuY29kZWQgYnkgcGxhaW4gb2xkIG9iamVjdHMuXG4vLyBJZiBxdWVyeSBpcyBudWxsLCB0aGlzIGlzIGEgXCJjcmVhdGVcIiBhbmQgdGhlIGRhdGEgaW4gZGF0YSBzaG91bGQgYmVcbi8vIGNyZWF0ZWQuXG4vLyBPdGhlcndpc2UgdGhpcyBpcyBhbiBcInVwZGF0ZVwiIC0gdGhlIG9iamVjdCBtYXRjaGluZyB0aGUgcXVlcnlcbi8vIHNob3VsZCBnZXQgdXBkYXRlZCB3aXRoIGRhdGEuXG4vLyBSZXN0V3JpdGUgd2lsbCBoYW5kbGUgb2JqZWN0SWQsIGNyZWF0ZWRBdCwgYW5kIHVwZGF0ZWRBdCBmb3Jcbi8vIGV2ZXJ5dGhpbmcuIEl0IGFsc28ga25vd3MgdG8gdXNlIHRyaWdnZXJzIGFuZCBzcGVjaWFsIG1vZGlmaWNhdGlvbnNcbi8vIGZvciB0aGUgX1VzZXIgY2xhc3MuXG5mdW5jdGlvbiBSZXN0V3JpdGUoY29uZmlnLCBhdXRoLCBjbGFzc05hbWUsIHF1ZXJ5LCBkYXRhLCBvcmlnaW5hbERhdGEsIGNvbnRleHQsIGFjdGlvbikge1xuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgJ0Nhbm5vdCBwZXJmb3JtIGEgd3JpdGUgb3BlcmF0aW9uIHdoZW4gdXNpbmcgcmVhZE9ubHlNYXN0ZXJLZXknLFxuICAgICAgY29uZmlnXG4gICAgKTtcbiAgfVxuICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgdGhpcy5hdXRoID0gYXV0aDtcbiAgdGhpcy5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gIHRoaXMuc3RvcmFnZSA9IHt9O1xuICB0aGlzLnJ1bk9wdGlvbnMgPSB7fTtcbiAgdGhpcy5jb250ZXh0ID0gY29udGV4dCB8fCB7fTtcblxuICBpZiAoYWN0aW9uKSB7XG4gICAgdGhpcy5ydW5PcHRpb25zLmFjdGlvbiA9IGFjdGlvbjtcbiAgfVxuXG4gIGlmICghcXVlcnkpIHtcbiAgICBpZiAodGhpcy5jb25maWcuYWxsb3dDdXN0b21PYmplY3RJZCkge1xuICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChkYXRhLCAnb2JqZWN0SWQnKSAmJiAhZGF0YS5vYmplY3RJZCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuTUlTU0lOR19PQkpFQ1RfSUQsXG4gICAgICAgICAgJ29iamVjdElkIG11c3Qgbm90IGJlIGVtcHR5LCBudWxsIG9yIHVuZGVmaW5lZCdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKGRhdGEub2JqZWN0SWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdvYmplY3RJZCBpcyBhbiBpbnZhbGlkIGZpZWxkIG5hbWUuJyk7XG4gICAgICB9XG4gICAgICBpZiAoZGF0YS5pZCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ2lkIGlzIGFuIGludmFsaWQgZmllbGQgbmFtZS4nKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBXaGVuIHRoZSBvcGVyYXRpb24gaXMgY29tcGxldGUsIHRoaXMucmVzcG9uc2UgbWF5IGhhdmUgc2V2ZXJhbFxuICAvLyBmaWVsZHMuXG4gIC8vIHJlc3BvbnNlOiB0aGUgYWN0dWFsIGRhdGEgdG8gYmUgcmV0dXJuZWRcbiAgLy8gc3RhdHVzOiB0aGUgaHR0cCBzdGF0dXMgY29kZS4gaWYgbm90IHByZXNlbnQsIHRyZWF0ZWQgbGlrZSBhIDIwMFxuICAvLyBsb2NhdGlvbjogdGhlIGxvY2F0aW9uIGhlYWRlci4gaWYgbm90IHByZXNlbnQsIG5vIGxvY2F0aW9uIGhlYWRlclxuICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcblxuICAvLyBQcm9jZXNzaW5nIHRoaXMgb3BlcmF0aW9uIG1heSBtdXRhdGUgb3VyIGRhdGEsIHNvIHdlIG9wZXJhdGUgb24gYVxuICAvLyBjb3B5XG4gIHRoaXMucXVlcnkgPSBzdHJ1Y3R1cmVkQ2xvbmUocXVlcnkpO1xuICB0aGlzLmRhdGEgPSBzdHJ1Y3R1cmVkQ2xvbmUoZGF0YSk7XG4gIC8vIFdlIG5ldmVyIGNoYW5nZSBvcmlnaW5hbERhdGEsIHNvIHdlIGRvIG5vdCBuZWVkIGEgZGVlcCBjb3B5XG4gIHRoaXMub3JpZ2luYWxEYXRhID0gb3JpZ2luYWxEYXRhO1xuXG4gIC8vIFRoZSB0aW1lc3RhbXAgd2UnbGwgdXNlIGZvciB0aGlzIHdob2xlIG9wZXJhdGlvblxuICB0aGlzLnVwZGF0ZWRBdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSkuaXNvO1xuXG4gIC8vIFNoYXJlZCBTY2hlbWFDb250cm9sbGVyIHRvIGJlIHJldXNlZCB0byByZWR1Y2UgdGhlIG51bWJlciBvZiBsb2FkU2NoZW1hKCkgY2FsbHMgcGVyIHJlcXVlc3RcbiAgLy8gT25jZSBzZXQgdGhlIHNjaGVtYURhdGEgc2hvdWxkIGJlIGltbXV0YWJsZVxuICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlciA9IG51bGw7XG4gIHRoaXMucGVuZGluZ09wcyA9IHtcbiAgICBvcGVyYXRpb25zOiBudWxsLFxuICAgIGlkZW50aWZpZXI6IG51bGwsXG4gIH07XG59XG5cbi8vIEEgY29udmVuaWVudCBtZXRob2QgdG8gcGVyZm9ybSBhbGwgdGhlIHN0ZXBzIG9mIHByb2Nlc3NpbmcgdGhlXG4vLyB3cml0ZSwgaW4gb3JkZXIuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSB7cmVzcG9uc2UsIHN0YXR1cywgbG9jYXRpb259IG9iamVjdC5cbi8vIHN0YXR1cyBhbmQgbG9jYXRpb24gYXJlIG9wdGlvbmFsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5nZXRVc2VyQW5kUm9sZUFDTCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVJbnN0YWxsYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZVNlc3Npb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQXV0aERhdGEoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNoZWNrUmVzdHJpY3RlZEZpZWxkcygpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuQmVmb3JlU2F2ZVRyaWdnZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmVuc3VyZVVuaXF1ZUF1dGhEYXRhSWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZVNjaGVtYSgpO1xuICAgIH0pXG4gICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlciA9IHNjaGVtYUNvbnRyb2xsZXI7XG4gICAgICByZXR1cm4gdGhpcy5zZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUNyZWF0ZVBlcm1pc3Npb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnRyYW5zZm9ybVVzZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5EYXRhYmFzZU9wZXJhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5BZnRlclNhdmVUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jbGVhblVzZXJBdXRoRGF0YSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZmlsdGVyUHJvdGVjdGVkRmllbGRzSW5SZXNwb25zZSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gQXBwZW5kIHRoZSBhdXRoRGF0YVJlc3BvbnNlIGlmIGV4aXN0c1xuICAgICAgaWYgKHRoaXMuYXV0aERhdGFSZXNwb25zZSkge1xuICAgICAgICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5hdXRoRGF0YVJlc3BvbnNlID0gdGhpcy5hdXRoRGF0YVJlc3BvbnNlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5zdG9yYWdlLnJlamVjdFNpZ251cCAmJiB0aGlzLmNvbmZpZy5wcmV2ZW50U2lnbnVwV2l0aFVudmVyaWZpZWRFbWFpbCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRU1BSUxfTk9UX0ZPVU5ELCAnVXNlciBlbWFpbCBpcyBub3QgdmVyaWZpZWQuJyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5yZXNwb25zZTtcbiAgICB9KTtcbn07XG5cbi8vIFVzZXMgdGhlIEF1dGggb2JqZWN0IHRvIGdldCB0aGUgbGlzdCBvZiByb2xlcywgYWRkcyB0aGUgdXNlciBpZFxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VyQW5kUm9sZUFDTCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMucnVuT3B0aW9ucy5hY2wgPSBbJyonXTtcblxuICBpZiAodGhpcy5hdXRoLnVzZXIpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLmdldFVzZXJSb2xlcygpLnRoZW4ocm9sZXMgPT4ge1xuICAgICAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IHRoaXMucnVuT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbdGhpcy5hdXRoLnVzZXIuaWRdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmIChcbiAgICB0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmXG4gICAgIXRoaXMuYXV0aC5pc01hc3RlciAmJlxuICAgICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJlxuICAgIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTFcbiAgKSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICAnVGhpcyB1c2VyIGlzIG5vdCBhbGxvd2VkIHRvIGFjY2VzcyBub24tZXhpc3RlbnQgY2xhc3M6ICcgKyB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHRoaXMuY29uZmlnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgc2NoZW1hLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZVNjaGVtYSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnZhbGlkYXRlT2JqZWN0KFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRoaXMuZGF0YSxcbiAgICB0aGlzLnF1ZXJ5LFxuICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICB0aGlzLmF1dGguaXNNYWludGVuYW5jZVxuICApO1xufTtcblxuLy8gUnVucyBhbnkgYmVmb3JlU2F2ZSB0cmlnZ2VycyBhZ2FpbnN0IHRoaXMgb3BlcmF0aW9uLlxuLy8gQW55IGNoYW5nZSBsZWFkcyB0byBvdXIgZGF0YSBiZWluZyBtdXRhdGVkLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5CZWZvcmVTYXZlVHJpZ2dlciA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5ydW5PcHRpb25zLm1hbnkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdiZWZvcmVTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBpZiAoXG4gICAgIXRyaWdnZXJzLnRyaWdnZXJFeGlzdHModGhpcy5jbGFzc05hbWUsIHRyaWdnZXJzLlR5cGVzLmJlZm9yZVNhdmUsIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWQpXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGNvbnN0IHsgb3JpZ2luYWxPYmplY3QsIHVwZGF0ZWRPYmplY3QgfSA9IHRoaXMuYnVpbGRQYXJzZU9iamVjdHMoKTtcbiAgY29uc3QgaWRlbnRpZmllciA9IHVwZGF0ZWRPYmplY3QuX2dldFN0YXRlSWRlbnRpZmllcigpO1xuICBjb25zdCBzdGF0ZUNvbnRyb2xsZXIgPSBQYXJzZS5Db3JlTWFuYWdlci5nZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIoKTtcbiAgY29uc3QgW3BlbmRpbmddID0gc3RhdGVDb250cm9sbGVyLmdldFBlbmRpbmdPcHMoaWRlbnRpZmllcik7XG4gIHRoaXMucGVuZGluZ09wcyA9IHtcbiAgICBvcGVyYXRpb25zOiB7IC4uLnBlbmRpbmcgfSxcbiAgICBpZGVudGlmaWVyLFxuICB9O1xuXG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIEJlZm9yZSBjYWxsaW5nIHRoZSB0cmlnZ2VyLCB2YWxpZGF0ZSB0aGUgcGVybWlzc2lvbnMgZm9yIHRoZSBzYXZlIG9wZXJhdGlvblxuICAgICAgbGV0IGRhdGFiYXNlUHJvbWlzZSA9IG51bGw7XG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgdXBkYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICB0cnVlLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFZhbGlkYXRlIGZvciBjcmVhdGluZ1xuICAgICAgICBkYXRhYmFzZVByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS5jcmVhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBJbiB0aGUgY2FzZSB0aGF0IHRoZXJlIGlzIG5vIHBlcm1pc3Npb24gZm9yIHRoZSBvcGVyYXRpb24sIGl0IHRocm93cyBhbiBlcnJvclxuICAgICAgcmV0dXJuIGRhdGFiYXNlUHJvbWlzZS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmICghcmVzdWx0IHx8IHJlc3VsdC5sZW5ndGggPD0gMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZC4nKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLFxuICAgICAgICB0aGlzLmF1dGgsXG4gICAgICAgIHVwZGF0ZWRPYmplY3QsXG4gICAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgICB0aGlzLmNvbmZpZyxcbiAgICAgICAgdGhpcy5jb250ZXh0XG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgaWYgKHJlc3BvbnNlICYmIHJlc3BvbnNlLm9iamVjdCkge1xuICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciA9IF8ucmVkdWNlKFxuICAgICAgICAgIHJlc3BvbnNlLm9iamVjdCxcbiAgICAgICAgICAocmVzdWx0LCB2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFcXVhbCh0aGlzLmRhdGFba2V5XSwgdmFsdWUpKSB7XG4gICAgICAgICAgICAgIHJlc3VsdC5wdXNoKGtleSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgIH0sXG4gICAgICAgICAgW11cbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5kYXRhID0gcmVzcG9uc2Uub2JqZWN0O1xuICAgICAgICAvLyBXZSBzaG91bGQgZGVsZXRlIHRoZSBvYmplY3RJZCBmb3IgYW4gdXBkYXRlIHdyaXRlXG4gICAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBVdGlscy5jaGVja1Byb2hpYml0ZWRLZXl3b3Jkcyh0aGlzLmNvbmZpZywgdGhpcy5kYXRhKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCBgJHtlcnJvcn1gKTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQmVmb3JlTG9naW5UcmlnZ2VyID0gYXN5bmMgZnVuY3Rpb24gKHVzZXJEYXRhKSB7XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2JlZm9yZUxvZ2luJyB0cmlnZ2VyXG4gIGlmIChcbiAgICAhdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyh0aGlzLmNsYXNzTmFtZSwgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlTG9naW4sIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWQpXG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENsb3VkIGNvZGUgZ2V0cyBhIGJpdCBvZiBleHRyYSBkYXRhIGZvciBpdHMgb2JqZWN0c1xuICBjb25zdCBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUgfTtcblxuICAvLyBFeHBhbmQgZmlsZSBvYmplY3RzXG4gIGF3YWl0IHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHRoaXMuY29uZmlnLCB1c2VyRGF0YSk7XG5cbiAgY29uc3QgdXNlciA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB1c2VyRGF0YSk7XG5cbiAgLy8gbm8gbmVlZCB0byByZXR1cm4gYSByZXNwb25zZVxuICBhd2FpdCB0cmlnZ2Vycy5tYXliZVJ1blRyaWdnZXIoXG4gICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlTG9naW4sXG4gICAgdGhpcy5hdXRoLFxuICAgIHVzZXIsXG4gICAgbnVsbCxcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmNvbnRleHRcbiAgKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuc2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuZGF0YSkge1xuICAgIHJldHVybiB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlci5nZXRBbGxDbGFzc2VzKCkudGhlbihhbGxDbGFzc2VzID0+IHtcbiAgICAgIGNvbnN0IHNjaGVtYSA9IGFsbENsYXNzZXMuZmluZChvbmVDbGFzcyA9PiBvbmVDbGFzcy5jbGFzc05hbWUgPT09IHRoaXMuY2xhc3NOYW1lKTtcbiAgICAgIGNvbnN0IHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCA9IChmaWVsZE5hbWUsIHNldERlZmF1bHQpID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gbnVsbCB8fFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnJyB8fFxuICAgICAgICAgICh0eXBlb2YgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09ICdvYmplY3QnICYmIHRoaXMuZGF0YVtmaWVsZE5hbWVdLl9fb3AgPT09ICdEZWxldGUnKVxuICAgICAgICApIHtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBzZXREZWZhdWx0ICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5kZWZhdWx0VmFsdWUgIT09IG51bGwgJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5kZWZhdWx0VmFsdWUgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAgICAgKHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICAgICAgKHR5cGVvZiB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gJ29iamVjdCcgJiYgdGhpcy5kYXRhW2ZpZWxkTmFtZV0uX19vcCA9PT0gJ0RlbGV0ZScpKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlO1xuICAgICAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciB8fCBbXTtcbiAgICAgICAgICAgIGlmICh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5pbmRleE9mKGZpZWxkTmFtZSkgPCAwKSB7XG4gICAgICAgICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucmVxdWlyZWQgPT09IHRydWUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBgJHtmaWVsZE5hbWV9IGlzIHJlcXVpcmVkYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICAvLyBhZGQgZGVmYXVsdCBBQ0wgKG9ubHkgb24gQ1JFQVRFLCBub3QgVVBEQVRFKVxuICAgICAgaWYgKCF0aGlzLnF1ZXJ5ICYmXG4gICAgICAgIHNjaGVtYT8uY2xhc3NMZXZlbFBlcm1pc3Npb25zPy5BQ0wgJiZcbiAgICAgICAgIXRoaXMuZGF0YS5BQ0wgJiZcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkoc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucy5BQ0wpICE9PVxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHsgJyonOiB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH0gfSlcbiAgICAgICkge1xuICAgICAgICBjb25zdCBhY2wgPSBzdHJ1Y3R1cmVkQ2xvbmUoc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucy5BQ0wpO1xuICAgICAgICBpZiAoYWNsLmN1cnJlbnRVc2VyKSB7XG4gICAgICAgICAgaWYgKHRoaXMuYXV0aC51c2VyPy5pZCkge1xuICAgICAgICAgICAgYWNsW3RoaXMuYXV0aC51c2VyPy5pZF0gPSBzdHJ1Y3R1cmVkQ2xvbmUoYWNsLmN1cnJlbnRVc2VyKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZGVsZXRlIGFjbC5jdXJyZW50VXNlcjtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmRhdGEuQUNMID0gYWNsO1xuICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciA9IHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIHx8IFtdO1xuICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5wdXNoKCdBQ0wnKTtcbiAgICAgIH1cblxuICAgICAgLy8gQWRkIGRlZmF1bHQgZmllbGRzXG4gICAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgICAgLy8gYWxsb3cgY3VzdG9taXppbmcgY3JlYXRlZEF0IGFuZCB1cGRhdGVkQXQgd2hlbiB1c2luZyBtYWludGVuYW5jZSBrZXlcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuYXV0aC5pc01haW50ZW5hbmNlICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQuX190eXBlID09PSAnRGF0ZSdcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCA9IHRoaXMuZGF0YS5jcmVhdGVkQXQuaXNvO1xuXG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS51cGRhdGVkQXQgJiYgdGhpcy5kYXRhLnVwZGF0ZWRBdC5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgICAgICAgY29uc3QgY3JlYXRlZEF0ID0gbmV3IERhdGUodGhpcy5kYXRhLmNyZWF0ZWRBdCk7XG4gICAgICAgICAgICBjb25zdCB1cGRhdGVkQXQgPSBuZXcgRGF0ZSh0aGlzLmRhdGEudXBkYXRlZEF0Lmlzbyk7XG5cbiAgICAgICAgICAgIGlmICh1cGRhdGVkQXQgPCBjcmVhdGVkQXQpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgICAgJ3VwZGF0ZWRBdCBjYW5ub3Qgb2NjdXIgYmVmb3JlIGNyZWF0ZWRBdCdcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5kYXRhLnVwZGF0ZWRBdCA9IHRoaXMuZGF0YS51cGRhdGVkQXQuaXNvO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBpZiBubyB1cGRhdGVkQXQgaXMgcHJvdmlkZWQsIHNldCBpdCB0byBjcmVhdGVkQXQgdG8gbWF0Y2ggZGVmYXVsdCBiZWhhdmlvclxuICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5kYXRhLnVwZGF0ZWRBdCA9IHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICAgICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBPbmx5IGFzc2lnbiBuZXcgb2JqZWN0SWQgaWYgd2UgYXJlIGNyZWF0aW5nIG5ldyBvYmplY3RcbiAgICAgICAgaWYgKCF0aGlzLmRhdGEub2JqZWN0SWQpIHtcbiAgICAgICAgICB0aGlzLmRhdGEub2JqZWN0SWQgPSBjcnlwdG9VdGlscy5uZXdPYmplY3RJZCh0aGlzLmNvbmZpZy5vYmplY3RJZFNpemUpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzY2hlbWEpIHtcbiAgICAgICAgICBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICAgICAgICBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQoZmllbGROYW1lLCB0cnVlKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChzY2hlbWEpIHtcbiAgICAgICAgdGhpcy5kYXRhLnVwZGF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuXG4gICAgICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YSkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgIHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZChmaWVsZE5hbWUsIGZhbHNlKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuLy8gVHJhbnNmb3JtcyBhdXRoIGRhdGEgZm9yIGEgdXNlciBvYmplY3QuXG4vLyBEb2VzIG5vdGhpbmcgaWYgdGhpcyBpc24ndCBhIHVzZXIgb2JqZWN0LlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUF1dGhEYXRhID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBhdXRoRGF0YSA9IHRoaXMuZGF0YS5hdXRoRGF0YTtcbiAgY29uc3QgaGFzVXNlcm5hbWVBbmRQYXNzd29yZCA9XG4gICAgdHlwZW9mIHRoaXMuZGF0YS51c2VybmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIHRoaXMuZGF0YS5wYXNzd29yZCA9PT0gJ3N0cmluZyc7XG4gIGNvbnN0IGhhc0F1dGhEYXRhID1cbiAgICBhdXRoRGF0YSAmJlxuICAgIE9iamVjdC5rZXlzKGF1dGhEYXRhKS5zb21lKHByb3ZpZGVyID0+IHtcbiAgICAgIGNvbnN0IHByb3ZpZGVyRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgIHJldHVybiBwcm92aWRlckRhdGEgJiYgdHlwZW9mIHByb3ZpZGVyRGF0YSA9PT0gJ29iamVjdCcgJiYgT2JqZWN0LmtleXMocHJvdmlkZXJEYXRhKS5sZW5ndGg7XG4gICAgfSk7XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICFoYXNBdXRoRGF0YSkge1xuICAgIGlmICh0eXBlb2YgdGhpcy5kYXRhLnVzZXJuYW1lICE9PSAnc3RyaW5nJyB8fCBfLmlzRW1wdHkodGhpcy5kYXRhLnVzZXJuYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlVTRVJOQU1FX01JU1NJTkcsICdiYWQgb3IgbWlzc2luZyB1c2VybmFtZScpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHRoaXMuZGF0YS5wYXNzd29yZCAhPT0gJ3N0cmluZycgfHwgXy5pc0VtcHR5KHRoaXMuZGF0YS5wYXNzd29yZCkpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5QQVNTV09SRF9NSVNTSU5HLCAncGFzc3dvcmQgaXMgcmVxdWlyZWQnKTtcbiAgICB9XG4gIH1cblxuICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh0aGlzLmRhdGEsICdhdXRoRGF0YScpKSB7XG4gICAgLy8gTm90aGluZyB0byB2YWxpZGF0ZSBoZXJlXG4gICAgcmV0dXJuO1xuICB9IGVsc2UgaWYgKCF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICAvLyBIYW5kbGUgc2F2aW5nIGF1dGhEYXRhIHRvIG51bGxcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLidcbiAgICApO1xuICB9XG5cbiAgdmFyIHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgaWYgKCFwcm92aWRlcnMubGVuZ3RoKSB7XG4gICAgLy8gRW1wdHkgYXV0aERhdGEgb2JqZWN0LCBub3RoaW5nIHRvIHZhbGlkYXRlXG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGNhbkhhbmRsZUF1dGhEYXRhID0gcHJvdmlkZXJzLnNvbWUocHJvdmlkZXIgPT4ge1xuICAgIGNvbnN0IHByb3ZpZGVyQXV0aERhdGEgPSBhdXRoRGF0YVtwcm92aWRlcl0gfHwge307XG4gICAgcmV0dXJuICEhT2JqZWN0LmtleXMocHJvdmlkZXJBdXRoRGF0YSkubGVuZ3RoO1xuICB9KTtcbiAgaWYgKGNhbkhhbmRsZUF1dGhEYXRhIHx8IGhhc1VzZXJuYW1lQW5kUGFzc3dvcmQgfHwgdGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuZ2V0VXNlcklkKCkpIHtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoRGF0YShhdXRoRGF0YSk7XG4gIH1cbiAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgIFBhcnNlLkVycm9yLlVOU1VQUE9SVEVEX1NFUlZJQ0UsXG4gICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLidcbiAgKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZmlsdGVyZWRPYmplY3RzQnlBQ0wgPSBmdW5jdGlvbiAob2JqZWN0cykge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuIG9iamVjdHM7XG4gIH1cbiAgcmV0dXJuIG9iamVjdHMuZmlsdGVyKG9iamVjdCA9PiB7XG4gICAgaWYgKCFvYmplY3QuQUNMKSB7XG4gICAgICByZXR1cm4gdHJ1ZTsgLy8gbGVnYWN5IHVzZXJzIHRoYXQgaGF2ZSBubyBBQ0wgZmllbGQgb24gdGhlbVxuICAgIH1cbiAgICAvLyBSZWd1bGFyIHVzZXJzIHRoYXQgaGF2ZSBiZWVuIGxvY2tlZCBvdXQuXG4gICAgcmV0dXJuIG9iamVjdC5BQ0wgJiYgT2JqZWN0LmtleXMob2JqZWN0LkFDTCkubGVuZ3RoID4gMDtcbiAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmdldFVzZXJJZCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCAmJiB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIHJldHVybiB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICB9IGVsc2UgaWYgKHRoaXMuYXV0aCAmJiB0aGlzLmF1dGgudXNlciAmJiB0aGlzLmF1dGgudXNlci5pZCkge1xuICAgIHJldHVybiB0aGlzLmF1dGgudXNlci5pZDtcbiAgfVxufTtcblxuLy8gRGV2ZWxvcGVycyBhcmUgYWxsb3dlZCB0byBjaGFuZ2UgYXV0aERhdGEgdmlhIGJlZm9yZSBzYXZlIHRyaWdnZXJcblJlc3RXcml0ZS5wcm90b3R5cGUuX3Rocm93SWZBdXRoRGF0YUR1cGxpY2F0ZSA9IGZ1bmN0aW9uIChlcnJvcikge1xuICBpZiAoXG4gICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICBlcnJvcj8uY29kZSA9PT0gUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFICYmXG4gICAgZXJyb3IudXNlckluZm8/LmR1cGxpY2F0ZWRfZmllbGQ/LnN0YXJ0c1dpdGgoJ19hdXRoX2RhdGFfJylcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsICd0aGlzIGF1dGggaXMgYWxyZWFkeSB1c2VkJyk7XG4gIH1cbn07XG5cbi8vIHdlIG5lZWQgYWZ0ZXIgYmVmb3JlIHNhdmUgdG8gZW5zdXJlIHRoYXQgdGhlIGRldmVsb3BlclxuLy8gaXMgbm90IGN1cnJlbnRseSBkdXBsaWNhdGluZyBhdXRoIGRhdGEgSURcblJlc3RXcml0ZS5wcm90b3R5cGUuZW5zdXJlVW5pcXVlQXV0aERhdGFJZCA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8ICF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBoYXNBdXRoRGF0YUlkID0gT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5zb21lKFxuICAgIGtleSA9PiB0aGlzLmRhdGEuYXV0aERhdGFba2V5XSAmJiB0aGlzLmRhdGEuYXV0aERhdGFba2V5XS5pZFxuICApO1xuXG4gIGlmICghaGFzQXV0aERhdGFJZCkgeyByZXR1cm47IH1cblxuICBjb25zdCByID0gYXdhaXQgQXV0aC5maW5kVXNlcnNXaXRoQXV0aERhdGEodGhpcy5jb25maWcsIHRoaXMuZGF0YS5hdXRoRGF0YSk7XG4gIGNvbnN0IHJlc3VsdHMgPSB0aGlzLmZpbHRlcmVkT2JqZWN0c0J5QUNMKHIpO1xuICBpZiAocmVzdWx0cy5sZW5ndGggPiAxKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsICd0aGlzIGF1dGggaXMgYWxyZWFkeSB1c2VkJyk7XG4gIH1cbiAgLy8gdXNlIGRhdGEub2JqZWN0SWQgaW4gY2FzZSBvZiBsb2dpbiB0aW1lIGFuZCBmb3VuZCB1c2VyIGR1cmluZyBoYW5kbGUgdmFsaWRhdGVBdXRoRGF0YVxuICBjb25zdCB1c2VySWQgPSB0aGlzLmdldFVzZXJJZCgpIHx8IHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgaWYgKHJlc3VsdHMubGVuZ3RoID09PSAxICYmIHVzZXJJZCAhPT0gcmVzdWx0c1swXS5vYmplY3RJZCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUF1dGhEYXRhID0gYXN5bmMgZnVuY3Rpb24gKGF1dGhEYXRhKSB7XG4gIGxldCBjdXJyZW50VXNlckF1dGhEYXRhO1xuICBpZiAodGhpcy5xdWVyeT8ub2JqZWN0SWQpIHtcbiAgICBjb25zdCBbY3VycmVudFVzZXJdID0gYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICdfVXNlcicsXG4gICAgICB7IG9iamVjdElkOiB0aGlzLnF1ZXJ5Lm9iamVjdElkIH1cbiAgICApO1xuICAgIGN1cnJlbnRVc2VyQXV0aERhdGEgPSBjdXJyZW50VXNlcj8uYXV0aERhdGE7XG4gIH1cbiAgY29uc3QgciA9IGF3YWl0IEF1dGguZmluZFVzZXJzV2l0aEF1dGhEYXRhKHRoaXMuY29uZmlnLCBhdXRoRGF0YSwgdHJ1ZSwgY3VycmVudFVzZXJBdXRoRGF0YSk7XG4gIGNvbnN0IHJlc3VsdHMgPSB0aGlzLmZpbHRlcmVkT2JqZWN0c0J5QUNMKHIpO1xuXG4gIGNvbnN0IHVzZXJJZCA9IHRoaXMuZ2V0VXNlcklkKCk7XG4gIGNvbnN0IHVzZXJSZXN1bHQgPSByZXN1bHRzWzBdO1xuICBjb25zdCBmb3VuZFVzZXJJc05vdEN1cnJlbnRVc2VyID0gdXNlcklkICYmIHVzZXJSZXN1bHQgJiYgdXNlcklkICE9PSB1c2VyUmVzdWx0Lm9iamVjdElkO1xuXG4gIGlmIChyZXN1bHRzLmxlbmd0aCA+IDEgfHwgZm91bmRVc2VySXNOb3RDdXJyZW50VXNlcikge1xuICAgIC8vIFRvIGF2b2lkIGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL3NlY3VyaXR5L2Fkdmlzb3JpZXMvR0hTQS04dzNqLWc5ODMtOGpoNVxuICAgIC8vIExldCdzIHJ1biBzb21lIHZhbGlkYXRpb24gYmVmb3JlIHRocm93aW5nXG4gICAgYXdhaXQgQXV0aC5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24oYXV0aERhdGEsIHRoaXMsIHVzZXJSZXN1bHQpO1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG5cbiAgLy8gTm8gdXNlciBmb3VuZCB3aXRoIHByb3ZpZGVkIGF1dGhEYXRhIHdlIG5lZWQgdG8gdmFsaWRhdGVcbiAgaWYgKCFyZXN1bHRzLmxlbmd0aCkge1xuICAgIGNvbnN0IHsgYXV0aERhdGE6IHZhbGlkYXRlZEF1dGhEYXRhLCBhdXRoRGF0YVJlc3BvbnNlIH0gPSBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihcbiAgICAgIGF1dGhEYXRhLFxuICAgICAgdGhpc1xuICAgICk7XG4gICAgdGhpcy5hdXRoRGF0YVJlc3BvbnNlID0gYXV0aERhdGFSZXNwb25zZTtcbiAgICAvLyBSZXBsYWNlIGN1cnJlbnQgYXV0aERhdGEgYnkgdGhlIG5ldyB2YWxpZGF0ZWQgb25lXG4gICAgdGhpcy5kYXRhLmF1dGhEYXRhID0gdmFsaWRhdGVkQXV0aERhdGE7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVXNlciBmb3VuZCB3aXRoIHByb3ZpZGVkIGF1dGhEYXRhXG4gIGlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMSkge1xuICAgIHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSkuam9pbignLCcpO1xuXG4gICAgY29uc3QgeyBoYXNNdXRhdGVkQXV0aERhdGEsIG11dGF0ZWRBdXRoRGF0YSB9ID0gQXV0aC5oYXNNdXRhdGVkQXV0aERhdGEoXG4gICAgICBhdXRoRGF0YSxcbiAgICAgIHVzZXJSZXN1bHQuYXV0aERhdGFcbiAgICApO1xuXG4gICAgY29uc3QgaXNDdXJyZW50VXNlckxvZ2dlZE9yTWFzdGVyID1cbiAgICAgICh0aGlzLmF1dGggJiYgdGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5hdXRoLnVzZXIuaWQgPT09IHVzZXJSZXN1bHQub2JqZWN0SWQpIHx8XG4gICAgICB0aGlzLmF1dGguaXNNYXN0ZXI7XG5cbiAgICBjb25zdCBpc0xvZ2luID0gIXVzZXJJZDtcblxuICAgIGlmIChpc0xvZ2luIHx8IGlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3Rlcikge1xuICAgICAgLy8gbm8gdXNlciBtYWtpbmcgdGhlIGNhbGxcbiAgICAgIC8vIE9SIHRoZSB1c2VyIG1ha2luZyB0aGUgY2FsbCBpcyB0aGUgcmlnaHQgb25lXG4gICAgICAvLyBMb2dpbiB3aXRoIGF1dGggZGF0YVxuICAgICAgZGVsZXRlIHJlc3VsdHNbMF0ucGFzc3dvcmQ7XG5cbiAgICAgIC8vIG5lZWQgdG8gc2V0IHRoZSBvYmplY3RJZCBmaXJzdCBvdGhlcndpc2UgbG9jYXRpb24gaGFzIHRyYWlsaW5nIHVuZGVmaW5lZFxuICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gdXNlclJlc3VsdC5vYmplY3RJZDtcblxuICAgICAgaWYgKCF0aGlzLnF1ZXJ5IHx8ICF0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgICAgcmVzcG9uc2U6IHVzZXJSZXN1bHQsXG4gICAgICAgICAgbG9jYXRpb246IHRoaXMubG9jYXRpb24oKSxcbiAgICAgICAgfTtcbiAgICAgICAgLy8gUnVuIGJlZm9yZUxvZ2luIGhvb2sgYmVmb3JlIHN0b3JpbmcgYW55IHVwZGF0ZXNcbiAgICAgICAgLy8gdG8gYXV0aERhdGEgb24gdGhlIGRiOyBjaGFuZ2VzIHRvIHVzZXJSZXN1bHRcbiAgICAgICAgLy8gd2lsbCBiZSBpZ25vcmVkLlxuICAgICAgICBhd2FpdCB0aGlzLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlcihzdHJ1Y3R1cmVkQ2xvbmUodXNlclJlc3VsdCkpO1xuXG4gICAgICAgIC8vIElmIHdlIGFyZSBpbiBsb2dpbiBvcGVyYXRpb24gdmlhIGF1dGhEYXRhXG4gICAgICAgIC8vIHdlIG5lZWQgdG8gYmUgc3VyZSB0aGF0IHRoZSB1c2VyIGhhcyBwcm92aWRlZFxuICAgICAgICAvLyByZXF1aXJlZCBhdXRoRGF0YVxuICAgICAgICBBdXRoLmNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4oXG4gICAgICAgICAgeyBjb25maWc6IHRoaXMuY29uZmlnLCBhdXRoOiB0aGlzLmF1dGggfSxcbiAgICAgICAgICBhdXRoRGF0YSxcbiAgICAgICAgICB1c2VyUmVzdWx0LmF1dGhEYXRhLFxuICAgICAgICAgIHRoaXMuY29uZmlnXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIC8vIFByZXZlbnQgdmFsaWRhdGluZyBpZiBubyBtdXRhdGVkIGRhdGEgZGV0ZWN0ZWQgb24gdXBkYXRlXG4gICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSAmJiBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBBbHdheXMgdmFsaWRhdGUgYWxsIHByb3ZpZGVkIGF1dGhEYXRhIG9uIGxvZ2luIHRvIHByZXZlbnQgYXV0aGVudGljYXRpb25cbiAgICAgIC8vIGJ5cGFzcyB2aWEgcGFydGlhbCBhdXRoRGF0YSAoZS5nLiBzZW5kaW5nIG9ubHkgdGhlIHByb3ZpZGVyIElEIHdpdGhvdXRcbiAgICAgIC8vIGFuIGFjY2VzcyB0b2tlbik7IG9uIHVwZGF0ZSBvbmx5IHZhbGlkYXRlIG11dGF0ZWQgb25lc1xuICAgICAgaWYgKGlzTG9naW4gfHwgaGFzTXV0YXRlZEF1dGhEYXRhIHx8ICF0aGlzLmNvbmZpZy5hbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuKSB7XG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IEF1dGguaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKFxuICAgICAgICAgIGlzTG9naW4gPyBhdXRoRGF0YSA6IG11dGF0ZWRBdXRoRGF0YSxcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgIHVzZXJSZXN1bHRcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5kYXRhLmF1dGhEYXRhID0gcmVzLmF1dGhEYXRhO1xuICAgICAgICB0aGlzLmF1dGhEYXRhUmVzcG9uc2UgPSByZXMuYXV0aERhdGFSZXNwb25zZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2FwdHVyZSBvcmlnaW5hbCBhdXRoRGF0YSBiZWZvcmUgbXV0YXRpbmcgdXNlclJlc3VsdCB2aWEgdGhlIHJlc3BvbnNlIHJlZmVyZW5jZVxuICAgICAgY29uc3Qgb3JpZ2luYWxBdXRoRGF0YSA9IHVzZXJSZXN1bHQ/LmF1dGhEYXRhXG4gICAgICAgID8gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgIE9iamVjdC5lbnRyaWVzKHVzZXJSZXN1bHQuYXV0aERhdGEpLm1hcCgoW2ssIHZdKSA9PlxuICAgICAgICAgICAgW2ssIHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnID8geyAuLi52IH0gOiB2XVxuICAgICAgICAgIClcbiAgICAgICAgKVxuICAgICAgICA6IHVuZGVmaW5lZDtcblxuICAgICAgLy8gSUYgd2UgYXJlIGluIGxvZ2luIHdlJ2xsIHNraXAgdGhlIGRhdGFiYXNlIG9wZXJhdGlvbiAvIGJlZm9yZVNhdmUgLyBhZnRlclNhdmUgZXRjLi4uXG4gICAgICAvLyB3ZSBuZWVkIHRvIHNldCBpdCB1cCB0aGVyZS5cbiAgICAgIC8vIFdlIGFyZSBzdXBwb3NlZCB0byBoYXZlIGEgcmVzcG9uc2Ugb25seSBvbiBMT0dJTiB3aXRoIGF1dGhEYXRhLCBzbyB3ZSBza2lwIHRob3NlXG4gICAgICAvLyBJZiB3ZSdyZSBub3QgbG9nZ2luZyBpbiwgYnV0IGp1c3QgdXBkYXRpbmcgdGhlIGN1cnJlbnQgdXNlciwgd2UgY2FuIHNhZmVseSBza2lwIHRoYXQgcGFydFxuICAgICAgaWYgKHRoaXMucmVzcG9uc2UpIHtcbiAgICAgICAgLy8gQXNzaWduIHRoZSBuZXcgYXV0aERhdGEgaW4gdGhlIHJlc3BvbnNlXG4gICAgICAgIE9iamVjdC5rZXlzKG11dGF0ZWRBdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5hdXRoRGF0YVtwcm92aWRlcl0gPSBtdXRhdGVkQXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBSdW4gdGhlIERCIHVwZGF0ZSBkaXJlY3RseSwgYXMgJ21hc3Rlcicgb25seSBpZiBhdXRoRGF0YSBjb250YWlucyBzb21lIGtleXNcbiAgICAgICAgLy8gYXV0aERhdGEgY291bGQgbm90IGNvbnRhaW5zIGtleXMgYWZ0ZXIgdmFsaWRhdGlvbiBpZiB0aGUgYXV0aEFkYXB0ZXJcbiAgICAgICAgLy8gdXNlcyB0aGUgYGRvTm90U2F2ZWAgb3B0aW9uLiBKdXN0IHVwZGF0ZSB0aGUgYXV0aERhdGEgcGFydFxuICAgICAgICAvLyBUaGVuIHdlJ3JlIGdvb2QgZm9yIHRoZSB1c2VyLCBlYXJseSBleGl0IG9mIHNvcnRzXG4gICAgICAgIGlmIChPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCkge1xuICAgICAgICAgIGNvbnN0IHF1ZXJ5ID0geyBvYmplY3RJZDogdGhpcy5kYXRhLm9iamVjdElkIH07XG4gICAgICAgICAgLy8gT3B0aW1pc3RpYyBsb2NraW5nOiBpbmNsdWRlIGVhY2ggY2hhbmdlZCBvcmlnaW5hbCBmaWVsZCBpbiB0aGUgV0hFUkUgY2xhdXNlXG4gICAgICAgICAgLy8gZm9yIHByb3ZpZGVycyB3aG9zZSBkYXRhIGlzIGJlaW5nIHVwZGF0ZWQuIFRoaXMgcHJldmVudHMgY29uY3VycmVudCByZXF1ZXN0c1xuICAgICAgICAgIC8vIGZyb20gYm90aCBzdWNjZWVkaW5nIHdoZW4gY29uc3VtaW5nIHNpbmdsZS11c2UgdG9rZW5zIChlLmcuIE1GQSByZWNvdmVyeSBjb2Rlc1xuICAgICAgICAgIC8vIGFzIGFycmF5cywgb3IgTUZBIFNNUyBPVFAgdG9rZW5zIGFzIHN0cmluZ3MpLlxuICAgICAgICAgIGFwcGx5QXV0aERhdGFPcHRpbWlzdGljTG9jayhxdWVyeSwgb3JpZ2luYWxBdXRoRGF0YSwgdGhpcy5kYXRhLmF1dGhEYXRhKTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgIHsgYXV0aERhdGE6IHRoaXMuZGF0YS5hdXRoRGF0YSB9LFxuICAgICAgICAgICAgICB7fVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsICdJbnZhbGlkIGF1dGggZGF0YScpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5fdGhyb3dJZkF1dGhEYXRhRHVwbGljYXRlKGVycm9yKTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMuZGF0YS5hdXRoRGF0YSAmJiBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCkge1xuICAgICAgICAvLyBVUERBVEUgcGF0aCAoZS5nLiBQVVQgL3VzZXJzLzppZCBkdXJpbmcgbGlua2VkLXByb3ZpZGVyIHJlLWF1dGgpOiBhcHBseVxuICAgICAgICAvLyB0aGUgc2FtZSBvcHRpbWlzdGljIGxvY2sgdG8gdGhlIHN1YnNlcXVlbnQgcnVuRGF0YWJhc2VPcGVyYXRpb24gdXBkYXRlIHNvXG4gICAgICAgIC8vIGNvbmN1cnJlbnQgc2luZ2xlLXVzZSB0b2tlbiBjb25zdW1lcnMgY2Fubm90IGJvdGggc3VjY2VlZC5cbiAgICAgICAgYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrKHRoaXMucXVlcnksIG9yaWdpbmFsQXV0aERhdGEsIHRoaXMuZGF0YS5hdXRoRGF0YSk7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNoZWNrUmVzdHJpY3RlZEZpZWxkcyA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICdlbWFpbFZlcmlmaWVkJyBpbiB0aGlzLmRhdGEpIHtcbiAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICBcIkNsaWVudHMgYXJlbid0IGFsbG93ZWQgdG8gbWFudWFsbHkgdXBkYXRlIGVtYWlsIHZlcmlmaWNhdGlvbi5cIixcbiAgICAgIHRoaXMuY29uZmlnXG4gICAgKTtcbiAgfVxufTtcblxuLy8gVmFsaWRhdGVzIHRoZSBjcmVhdGUgY2xhc3MtbGV2ZWwgcGVybWlzc2lvbiBiZWZvcmUgdHJhbnNmb3JtVXNlciBydW5zLlxuLy8gVGhpcyBwcmV2ZW50cyB1c2VyIGVudW1lcmF0aW9uICh1c2VybmFtZS9lbWFpbCBleGlzdGVuY2UpIHdoZW4gcHVibGljXG4vLyBjcmVhdGUgaXMgZGlzYWJsZWQgb24gX1VzZXIsIGJlY2F1c2UgdHJhbnNmb3JtVXNlciBjaGVja3MgdW5pcXVlbmVzc1xuLy8gYmVmb3JlIHRoZSBDTFAgaXMgZW5mb3JjZWQgaW4gcnVuRGF0YWJhc2VPcGVyYXRpb24uXG5SZXN0V3JpdGUucHJvdG90eXBlLnZhbGlkYXRlQ3JlYXRlUGVybWlzc2lvbiA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucXVlcnkgfHwgdGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRoaXMucnVuT3B0aW9ucy5hY2wgfHwgW10sXG4gICAgJ2NyZWF0ZSdcbiAgKTtcbn07XG5cbi8vIFRoZSBub24tdGhpcmQtcGFydHkgcGFydHMgb2YgVXNlciB0cmFuc2Zvcm1hdGlvblxuUmVzdFdyaXRlLnByb3RvdHlwZS50cmFuc2Zvcm1Vc2VyID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIC8vIERvIG5vdCBjbGVhbnVwIHNlc3Npb24gaWYgb2JqZWN0SWQgaXMgbm90IHNldFxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLm9iamVjdElkKCkpIHtcbiAgICAvLyBJZiB3ZSdyZSB1cGRhdGluZyBhIF9Vc2VyIG9iamVjdCwgd2UgbmVlZCB0byBjbGVhciBvdXQgdGhlIGNhY2hlIGZvciB0aGF0IHVzZXIuIEZpbmQgYWxsIHRoZWlyXG4gICAgLy8gc2Vzc2lvbiB0b2tlbnMsIGFuZCByZW1vdmUgdGhlbSBmcm9tIHRoZSBjYWNoZS5cbiAgICBjb25zdCBxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZmluZCxcbiAgICAgIGNvbmZpZzogdGhpcy5jb25maWcsXG4gICAgICBhdXRoOiBBdXRoLm1hc3Rlcih0aGlzLmNvbmZpZyksXG4gICAgICBjbGFzc05hbWU6ICdfU2Vzc2lvbicsXG4gICAgICBydW5CZWZvcmVGaW5kOiBmYWxzZSxcbiAgICAgIHJlc3RXaGVyZToge1xuICAgICAgICB1c2VyOiB7XG4gICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHByb21pc2UgPSBxdWVyeS5leGVjdXRlKCkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMucmVzdWx0cy5mb3JFYWNoKHNlc3Npb24gPT5cbiAgICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnVzZXIuZGVsKHNlc3Npb24uc2Vzc2lvblRva2VuKVxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBwcm9taXNlXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gVHJhbnNmb3JtIHRoZSBwYXNzd29yZFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIC8vIGlnbm9yZSBvbmx5IGlmIHVuZGVmaW5lZC4gc2hvdWxkIHByb2NlZWQgaWYgZW1wdHkgKCcnKVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddID0gdHJ1ZTtcbiAgICAgICAgLy8gR2VuZXJhdGUgYSBuZXcgc2Vzc2lvbiBvbmx5IGlmIHRoZSB1c2VyIHJlcXVlc3RlZFxuICAgICAgICBpZiAoIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICAgICAgICB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uaGFzaCh0aGlzLmRhdGEucGFzc3dvcmQpLnRoZW4oaGFzaGVkUGFzc3dvcmQgPT4ge1xuICAgICAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkID0gaGFzaGVkUGFzc3dvcmQ7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVVzZXJOYW1lKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVFbWFpbCgpO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVVc2VyTmFtZSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gQ2hlY2sgZm9yIHVzZXJuYW1lIHVuaXF1ZW5lc3NcbiAgaWYgKCF0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgIHRoaXMuZGF0YS51c2VybmFtZSA9IGNyeXB0b1V0aWxzLnJhbmRvbVN0cmluZygyNSk7XG4gICAgICB0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8qXG4gICAgVXNlcm5hbWVzIHNob3VsZCBiZSB1bmlxdWUgd2hlbiBjb21wYXJlZCBjYXNlIGluc2Vuc2l0aXZlbHlcblxuICAgIFVzZXJzIHNob3VsZCBiZSBhYmxlIHRvIG1ha2UgY2FzZSBzZW5zaXRpdmUgdXNlcm5hbWVzIGFuZFxuICAgIGxvZ2luIHVzaW5nIHRoZSBjYXNlIHRoZXkgZW50ZXJlZC4gIEkuZS4gJ1Nub29weScgc2hvdWxkIHByZWNsdWRlXG4gICAgJ3Nub29weScgYXMgYSB2YWxpZCB1c2VybmFtZS5cbiAgKi9cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHtcbiAgICAgICAgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSxcbiAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgIH0sXG4gICAgICB7IGxpbWl0OiAxLCBjYXNlSW5zZW5zaXRpdmU6IHRydWUgfSxcbiAgICAgIHt9LFxuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgICApXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUuYnVpbGRDcmVhdGVkV2l0aCA9IGZ1bmN0aW9uIChhY3Rpb24sIGF1dGhQcm92aWRlcikge1xuICByZXR1cm4geyBhY3Rpb24sIGF1dGhQcm92aWRlcjogYXV0aFByb3ZpZGVyIHx8ICdwYXNzd29yZCcgfTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZ2V0Q3JlYXRlZFdpdGggPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnN0b3JhZ2UuY3JlYXRlZFdpdGgpIHtcbiAgICByZXR1cm4gdGhpcy5zdG9yYWdlLmNyZWF0ZWRXaXRoO1xuICB9XG4gIGNvbnN0IGlzQ3JlYXRlT3BlcmF0aW9uID0gIXRoaXMucXVlcnk7XG4gIGNvbnN0IGF1dGhEYXRhUHJvdmlkZXIgPVxuICAgIHRoaXMuZGF0YT8uYXV0aERhdGEgJiZcbiAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCAmJlxuICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkuam9pbignLCcpO1xuICBjb25zdCBhdXRoUHJvdmlkZXIgPSB0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyIHx8IGF1dGhEYXRhUHJvdmlkZXI7XG4gIC8vIHN0b3JhZ2UuYXV0aFByb3ZpZGVyIGlzIG9ubHkgc2V0IGZvciBsb2dpbiAoZXhpc3RpbmcgdXNlciBmb3VuZCBpbiBoYW5kbGVBdXRoRGF0YSlcbiAgY29uc3QgYWN0aW9uID0gdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA/ICdsb2dpbicgOiBpc0NyZWF0ZU9wZXJhdGlvbiA/ICdzaWdudXAnIDogdW5kZWZpbmVkO1xuICBpZiAoIWFjdGlvbikge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCByZXNvbHZlZEF1dGhQcm92aWRlciA9IGF1dGhQcm92aWRlciB8fCAoYWN0aW9uID09PSAnc2lnbnVwJyA/ICdwYXNzd29yZCcgOiB1bmRlZmluZWQpO1xuICB0aGlzLnN0b3JhZ2UuY3JlYXRlZFdpdGggPSBSZXN0V3JpdGUuYnVpbGRDcmVhdGVkV2l0aChhY3Rpb24sIHJlc29sdmVkQXV0aFByb3ZpZGVyKTtcbiAgcmV0dXJuIHRoaXMuc3RvcmFnZS5jcmVhdGVkV2l0aDtcbn07XG5cbi8qXG4gIEFzIHdpdGggdXNlcm5hbWVzLCBQYXJzZSBzaG91bGQgbm90IGFsbG93IGNhc2UgaW5zZW5zaXRpdmUgY29sbGlzaW9ucyBvZiBlbWFpbC5cbiAgdW5saWtlIHdpdGggdXNlcm5hbWVzICh3aGljaCBjYW4gaGF2ZSBjYXNlIGluc2Vuc2l0aXZlIGNvbGxpc2lvbnMgaW4gdGhlIGNhc2Ugb2ZcbiAgYXV0aCBhZGFwdGVycyksIGVtYWlscyBzaG91bGQgbmV2ZXIgaGF2ZSBhIGNhc2UgaW5zZW5zaXRpdmUgY29sbGlzaW9uLlxuXG4gIFRoaXMgYmVoYXZpb3IgY2FuIGJlIGVuZm9yY2VkIHRocm91Z2ggYSBwcm9wZXJseSBjb25maWd1cmVkIGluZGV4IHNlZTpcbiAgaHR0cHM6Ly9kb2NzLm1vbmdvZGIuY29tL21hbnVhbC9jb3JlL2luZGV4LWNhc2UtaW5zZW5zaXRpdmUvI2NyZWF0ZS1hLWNhc2UtaW5zZW5zaXRpdmUtaW5kZXhcbiAgd2hpY2ggY291bGQgYmUgaW1wbGVtZW50ZWQgaW5zdGVhZCBvZiB0aGlzIGNvZGUgYmFzZWQgdmFsaWRhdGlvbi5cblxuICBHaXZlbiB0aGF0IHRoaXMgbG9va3VwIHNob3VsZCBiZSBhIHJlbGF0aXZlbHkgbG93IHVzZSBjYXNlIGFuZCB0aGF0IHRoZSBjYXNlIHNlbnNpdGl2ZVxuICB1bmlxdWUgaW5kZXggd2lsbCBiZSB1c2VkIGJ5IHRoZSBkYiBmb3IgdGhlIHF1ZXJ5LCB0aGlzIGlzIGFuIGFkZXF1YXRlIHNvbHV0aW9uLlxuKi9cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlRW1haWwgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5kYXRhLmVtYWlsIHx8IHRoaXMuZGF0YS5lbWFpbC5fX29wID09PSAnRGVsZXRlJykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBWYWxpZGF0ZSBiYXNpYyBlbWFpbCBhZGRyZXNzIGZvcm1hdFxuICBpZiAoIXRoaXMuZGF0YS5lbWFpbC5tYXRjaCgvXi4rQC4rJC8pKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfRU1BSUxfQUREUkVTUywgJ0VtYWlsIGFkZHJlc3MgZm9ybWF0IGlzIGludmFsaWQuJylcbiAgICApO1xuICB9XG4gIC8vIENhc2UgaW5zZW5zaXRpdmUgbWF0Y2gsIHNlZSBub3RlIGFib3ZlIGZ1bmN0aW9uLlxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZChcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAge1xuICAgICAgICBlbWFpbDogdGhpcy5kYXRhLmVtYWlsLFxuICAgICAgICBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgfSxcbiAgICAgIHsgbGltaXQ6IDEsIGNhc2VJbnNlbnNpdGl2ZTogdHJ1ZSB9LFxuICAgICAge30sXG4gICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgIClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICAhdGhpcy5kYXRhLmF1dGhEYXRhIHx8XG4gICAgICAgICFPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCB8fFxuICAgICAgICAoT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGggPT09IDEgJiZcbiAgICAgICAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpWzBdID09PSAnYW5vbnltb3VzJylcbiAgICAgICkge1xuICAgICAgICAvLyBXZSB1cGRhdGVkIHRoZSBlbWFpbCwgc2VuZCBhIG5ldyB2YWxpZGF0aW9uXG4gICAgICAgIGNvbnN0IHsgb3JpZ2luYWxPYmplY3QsIHVwZGF0ZWRPYmplY3QgfSA9IHRoaXMuYnVpbGRQYXJzZU9iamVjdHMoKTtcbiAgICAgICAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAgICAgICBvcmlnaW5hbDogb3JpZ2luYWxPYmplY3QsXG4gICAgICAgICAgb2JqZWN0OiB1cGRhdGVkT2JqZWN0LFxuICAgICAgICAgIG1hc3RlcjogdGhpcy5hdXRoLmlzTWFzdGVyLFxuICAgICAgICAgIGlwOiB0aGlzLmNvbmZpZy5pcCxcbiAgICAgICAgICBpbnN0YWxsYXRpb25JZDogdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkLFxuICAgICAgICAgIGNyZWF0ZWRXaXRoOiB0aGlzLmdldENyZWF0ZWRXaXRoKCksXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZXRFbWFpbFZlcmlmeVRva2VuKHRoaXMuZGF0YSwgcmVxdWVzdCwgdGhpcy5zdG9yYWdlKTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kpIHsgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOyB9XG4gIHJldHVybiB0aGlzLl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzKCkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5KCk7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cyA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gY2hlY2sgaWYgdGhlIHBhc3N3b3JkIGNvbmZvcm1zIHRvIHRoZSBkZWZpbmVkIHBhc3N3b3JkIHBvbGljeSBpZiBjb25maWd1cmVkXG4gIC8vIElmIHdlIHNwZWNpZmllZCBhIGN1c3RvbSBlcnJvciBpbiBvdXIgY29uZmlndXJhdGlvbiB1c2UgaXQuXG4gIC8vIEV4YW1wbGU6IFwiUGFzc3dvcmRzIG11c3QgaW5jbHVkZSBhIENhcGl0YWwgTGV0dGVyLCBMb3dlcmNhc2UgTGV0dGVyLCBhbmQgYSBudW1iZXIuXCJcbiAgLy9cbiAgLy8gVGhpcyBpcyBlc3BlY2lhbGx5IHVzZWZ1bCBvbiB0aGUgZ2VuZXJpYyBcInBhc3N3b3JkIHJlc2V0XCIgcGFnZSxcbiAgLy8gYXMgaXQgYWxsb3dzIHRoZSBwcm9ncmFtbWVyIHRvIGNvbW11bmljYXRlIHNwZWNpZmljIHJlcXVpcmVtZW50cyBpbnN0ZWFkIG9mOlxuICAvLyBhLiBtYWtpbmcgdGhlIHVzZXIgZ3Vlc3Mgd2hhdHMgd3JvbmdcbiAgLy8gYi4gbWFraW5nIGEgY3VzdG9tIHBhc3N3b3JkIHJlc2V0IHBhZ2UgdGhhdCBzaG93cyB0aGUgcmVxdWlyZW1lbnRzXG4gIGNvbnN0IHBvbGljeUVycm9yID0gdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdGlvbkVycm9yXG4gICAgPyB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0aW9uRXJyb3JcbiAgICA6ICdQYXNzd29yZCBkb2VzIG5vdCBtZWV0IHRoZSBQYXNzd29yZCBQb2xpY3kgcmVxdWlyZW1lbnRzLic7XG4gIGNvbnN0IGNvbnRhaW5zVXNlcm5hbWVFcnJvciA9ICdQYXNzd29yZCBjYW5ub3QgY29udGFpbiB5b3VyIHVzZXJuYW1lLic7XG5cbiAgLy8gY2hlY2sgd2hldGhlciB0aGUgcGFzc3dvcmQgbWVldHMgdGhlIHBhc3N3b3JkIHN0cmVuZ3RoIHJlcXVpcmVtZW50c1xuICBpZiAoXG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnBhdHRlcm5WYWxpZGF0b3IgJiZcbiAgICAgICF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yKHRoaXMuZGF0YS5wYXNzd29yZCkpIHx8XG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRvckNhbGxiYWNrICYmXG4gICAgICAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sodGhpcy5kYXRhLnBhc3N3b3JkKSlcbiAgKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBwb2xpY3lFcnJvcikpO1xuICB9XG5cbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBjb250YWluIHVzZXJuYW1lXG4gIGlmICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgPT09IHRydWUpIHtcbiAgICBpZiAodGhpcy5kYXRhLnVzZXJuYW1lKSB7XG4gICAgICAvLyB1c2VybmFtZSBpcyBub3QgcGFzc2VkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHRoaXMuZGF0YS51c2VybmFtZSkgPj0gMClcbiAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBjb250YWluc1VzZXJuYW1lRXJyb3IpKTsgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyByZXRyaWV2ZSB0aGUgVXNlciBvYmplY3QgdXNpbmcgb2JqZWN0SWQgZHVyaW5nIHBhc3N3b3JkIHJlc2V0XG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHJlc3VsdHNbMF0udXNlcm5hbWUpID49IDApXG4gICAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBjb250YWluc1VzZXJuYW1lRXJyb3IpXG4gICAgICAgICk7IH1cbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5ID0gZnVuY3Rpb24gKCkge1xuICAvLyBjaGVjayB3aGV0aGVyIHBhc3N3b3JkIGlzIHJlcGVhdGluZyBmcm9tIHNwZWNpZmllZCBoaXN0b3J5XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmZpbmQoXG4gICAgICAgICdfVXNlcicsXG4gICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICB7IGtleXM6IFsnX3Bhc3N3b3JkX2hpc3RvcnknLCAnX2hhc2hlZF9wYXNzd29yZCddIH0sXG4gICAgICAgIEF1dGgubWFpbnRlbmFuY2UodGhpcy5jb25maWcpXG4gICAgICApXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgIGxldCBvbGRQYXNzd29yZHMgPSBbXTtcbiAgICAgICAgaWYgKHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnkpXG4gICAgICAgIHsgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgIHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksXG4gICAgICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5IC0gMVxuICAgICAgICApOyB9XG4gICAgICAgIG9sZFBhc3N3b3Jkcy5wdXNoKHVzZXIucGFzc3dvcmQpO1xuICAgICAgICBjb25zdCBuZXdQYXNzd29yZCA9IHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgLy8gY29tcGFyZSB0aGUgbmV3IHBhc3N3b3JkIGhhc2ggd2l0aCBhbGwgb2xkIHBhc3N3b3JkIGhhc2hlc1xuICAgICAgICBjb25zdCBwcm9taXNlcyA9IG9sZFBhc3N3b3Jkcy5tYXAoZnVuY3Rpb24gKGhhc2gpIHtcbiAgICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uY29tcGFyZShuZXdQYXNzd29yZCwgaGFzaCkudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdClcbiAgICAgICAgICAgIC8vIHJlamVjdCBpZiB0aGVyZSBpcyBhIG1hdGNoXG4gICAgICAgICAgICB7IHJldHVybiBQcm9taXNlLnJlamVjdCgnUkVQRUFUX1BBU1NXT1JEJyk7IH1cbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIHdhaXQgZm9yIGFsbCBjb21wYXJpc29ucyB0byBjb21wbGV0ZVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwocHJvbWlzZXMpXG4gICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyID09PSAnUkVQRUFUX1BBU1NXT1JEJylcbiAgICAgICAgICAgIC8vIGEgbWF0Y2ggd2FzIGZvdW5kXG4gICAgICAgICAgICB7IHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgICAgYE5ldyBwYXNzd29yZCBzaG91bGQgbm90IGJlIHRoZSBzYW1lIGFzIGxhc3QgJHt0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3Rvcnl9IHBhc3N3b3Jkcy5gXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7IH1cbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEb24ndCBnZW5lcmF0ZSBzZXNzaW9uIGZvciB1cGRhdGluZyB1c2VyICh0aGlzLnF1ZXJ5IGlzIHNldCkgdW5sZXNzIGF1dGhEYXRhIGV4aXN0c1xuICBpZiAodGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERvbid0IGdlbmVyYXRlIG5ldyBzZXNzaW9uVG9rZW4gaWYgbGlua2luZyB2aWEgc2Vzc2lvblRva2VuXG4gIGlmICh0aGlzLmF1dGgudXNlciAmJiB0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gSWYgc2lnbi11cCBjYWxsXG4gIGlmICghdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlcikge1xuICAgIC8vIENyZWF0ZSByZXF1ZXN0IG9iamVjdCBmb3IgdmVyaWZpY2F0aW9uIGZ1bmN0aW9uc1xuICAgIGNvbnN0IHsgb3JpZ2luYWxPYmplY3QsIHVwZGF0ZWRPYmplY3QgfSA9IHRoaXMuYnVpbGRQYXJzZU9iamVjdHMoKTtcbiAgICBjb25zdCByZXF1ZXN0ID0ge1xuICAgICAgb3JpZ2luYWw6IG9yaWdpbmFsT2JqZWN0LFxuICAgICAgb2JqZWN0OiB1cGRhdGVkT2JqZWN0LFxuICAgICAgbWFzdGVyOiB0aGlzLmF1dGguaXNNYXN0ZXIsXG4gICAgICBpcDogdGhpcy5jb25maWcuaXAsXG4gICAgICBpbnN0YWxsYXRpb25JZDogdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkLFxuICAgICAgY3JlYXRlZFdpdGg6IHRoaXMuZ2V0Q3JlYXRlZFdpdGgoKSxcbiAgICB9O1xuICAgIC8vIEdldCB2ZXJpZmljYXRpb24gY29uZGl0aW9ucyB3aGljaCBjYW4gYmUgYm9vbGVhbnMgb3IgZnVuY3Rpb25zOyB0aGUgcHVycG9zZSBvZiB0aGlzIGFzeW5jL2F3YWl0XG4gICAgLy8gc3RydWN0dXJlIGlzIHRvIGF2b2lkIHVubmVjZXNzYXJpbHkgZXhlY3V0aW5nIHN1YnNlcXVlbnQgZnVuY3Rpb25zIGlmIHByZXZpb3VzIG9uZXMgZmFpbCBpbiB0aGVcbiAgICAvLyBjb25kaXRpb25hbCBzdGF0ZW1lbnQgYmVsb3csIGFzIGEgZGV2ZWxvcGVyIG1heSBkZWNpZGUgdG8gZXhlY3V0ZSBleHBlbnNpdmUgb3BlcmF0aW9ucyBpbiB0aGVtXG4gICAgY29uc3QgdmVyaWZ5VXNlckVtYWlscyA9IGFzeW5jICgpID0+IHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHMgPT09IHRydWUgfHwgKHR5cGVvZiB0aGlzLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzID09PSAnZnVuY3Rpb24nICYmIGF3YWl0IFByb21pc2UucmVzb2x2ZSh0aGlzLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzKHJlcXVlc3QpKSA9PT0gdHJ1ZSk7XG4gICAgY29uc3QgcHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCA9IGFzeW5jICgpID0+IHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPT09IHRydWUgfHwgKHR5cGVvZiB0aGlzLmNvbmZpZy5wcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID09PSAnZnVuY3Rpb24nICYmIGF3YWl0IFByb21pc2UucmVzb2x2ZSh0aGlzLmNvbmZpZy5wcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsKHJlcXVlc3QpKSA9PT0gdHJ1ZSk7XG4gICAgLy8gSWYgdmVyaWZpY2F0aW9uIGlzIHJlcXVpcmVkXG4gICAgaWYgKGF3YWl0IHZlcmlmeVVzZXJFbWFpbHMoKSAmJiBhd2FpdCBwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsKCkpIHtcbiAgICAgIHRoaXMuc3RvcmFnZS5yZWplY3RTaWdudXAgPSB0cnVlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW4oKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY3JlYXRlU2Vzc2lvblRva2VuID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICAvLyBjbG91ZCBpbnN0YWxsYXRpb25JZCBmcm9tIENsb3VkIENvZGUsXG4gIC8vIG5ldmVyIGNyZWF0ZSBzZXNzaW9uIHRva2VucyBmcm9tIHRoZXJlLlxuICBpZiAodGhpcy5hdXRoLmluc3RhbGxhdGlvbklkICYmIHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCA9PT0gJ2Nsb3VkJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyID09IG51bGwgJiYgdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkuam9pbignLCcpO1xuICAgIC8vIEludmFsaWRhdGUgY2FjaGVkIGNyZWF0ZWRXaXRoIHNpbmNlIGF1dGhQcm92aWRlciB3YXMganVzdCByZXNvbHZlZFxuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2UuY3JlYXRlZFdpdGg7XG4gIH1cblxuICBjb25zdCBjcmVhdGVkV2l0aCA9IHRoaXMuZ2V0Q3JlYXRlZFdpdGgoKTtcbiAgY29uc3QgeyBzZXNzaW9uRGF0YSwgY3JlYXRlU2Vzc2lvbiB9ID0gUmVzdFdyaXRlLmNyZWF0ZVNlc3Npb24odGhpcy5jb25maWcsIHtcbiAgICB1c2VySWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICBjcmVhdGVkV2l0aCxcbiAgICBpbnN0YWxsYXRpb25JZDogdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkLFxuICB9KTtcblxuICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5zZXNzaW9uVG9rZW4gPSBzZXNzaW9uRGF0YS5zZXNzaW9uVG9rZW47XG4gIH1cblxuICByZXR1cm4gY3JlYXRlU2Vzc2lvbigpO1xufTtcblxuUmVzdFdyaXRlLmNyZWF0ZVNlc3Npb24gPSBmdW5jdGlvbiAoXG4gIGNvbmZpZyxcbiAgeyB1c2VySWQsIGNyZWF0ZWRXaXRoLCBpbnN0YWxsYXRpb25JZCwgYWRkaXRpb25hbFNlc3Npb25EYXRhIH1cbikge1xuICBjb25zdCB0b2tlbiA9ICdyOicgKyBjcnlwdG9VdGlscy5uZXdUb2tlbigpO1xuICBjb25zdCBleHBpcmVzQXQgPSBjb25maWcuZ2VuZXJhdGVTZXNzaW9uRXhwaXJlc0F0KCk7XG4gIGNvbnN0IHNlc3Npb25EYXRhID0ge1xuICAgIHNlc3Npb25Ub2tlbjogdG9rZW4sXG4gICAgdXNlcjoge1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICBvYmplY3RJZDogdXNlcklkLFxuICAgIH0sXG4gICAgY3JlYXRlZFdpdGgsXG4gICAgZXhwaXJlc0F0OiBQYXJzZS5fZW5jb2RlKGV4cGlyZXNBdCksXG4gIH07XG5cbiAgaWYgKGluc3RhbGxhdGlvbklkKSB7XG4gICAgc2Vzc2lvbkRhdGEuaW5zdGFsbGF0aW9uSWQgPSBpbnN0YWxsYXRpb25JZDtcbiAgfVxuXG4gIE9iamVjdC5hc3NpZ24oc2Vzc2lvbkRhdGEsIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzZXNzaW9uRGF0YSxcbiAgICBjcmVhdGVTZXNzaW9uOiAoKSA9PlxuICAgICAgbmV3IFJlc3RXcml0ZShjb25maWcsIEF1dGgubWFzdGVyKGNvbmZpZyksICdfU2Vzc2lvbicsIG51bGwsIHNlc3Npb25EYXRhKS5leGVjdXRlKCksXG4gIH07XG59O1xuXG4vLyBEZWxldGUgZW1haWwgcmVzZXQgdG9rZW5zIGlmIHVzZXIgaXMgY2hhbmdpbmcgcGFzc3dvcmQgb3IgZW1haWwuXG5SZXN0V3JpdGUucHJvdG90eXBlLmRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicgfHwgdGhpcy5xdWVyeSA9PT0gbnVsbCkge1xuICAgIC8vIG51bGwgcXVlcnkgbWVhbnMgY3JlYXRlXG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCdwYXNzd29yZCcgaW4gdGhpcy5kYXRhIHx8ICdlbWFpbCcgaW4gdGhpcy5kYXRhKSB7XG4gICAgY29uc3QgYWRkT3BzID0ge1xuICAgICAgX3BlcmlzaGFibGVfdG9rZW46IHsgX19vcDogJ0RlbGV0ZScgfSxcbiAgICAgIF9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQ6IHsgX19vcDogJ0RlbGV0ZScgfSxcbiAgICB9O1xuICAgIHRoaXMuZGF0YSA9IE9iamVjdC5hc3NpZ24odGhpcy5kYXRhLCBhZGRPcHMpO1xuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIE9ubHkgZm9yIF9TZXNzaW9uLCBhbmQgYXQgY3JlYXRpb24gdGltZVxuICBpZiAodGhpcy5jbGFzc05hbWUgIT0gJ19TZXNzaW9uJyB8fCB0aGlzLnF1ZXJ5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERlc3Ryb3kgdGhlIHNlc3Npb25zIGluICdCYWNrZ3JvdW5kJ1xuICBjb25zdCB7IHVzZXIsIGluc3RhbGxhdGlvbklkLCBzZXNzaW9uVG9rZW4gfSA9IHRoaXMuZGF0YTtcbiAgaWYgKCF1c2VyIHx8ICFpbnN0YWxsYXRpb25JZCkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXVzZXIub2JqZWN0SWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koXG4gICAgJ19TZXNzaW9uJyxcbiAgICB7XG4gICAgICB1c2VyLFxuICAgICAgaW5zdGFsbGF0aW9uSWQsXG4gICAgICBzZXNzaW9uVG9rZW46IHsgJG5lOiBzZXNzaW9uVG9rZW4gfSxcbiAgICB9LFxuICAgIHt9LFxuICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICkuY2F0Y2goZSA9PiB7XG4gICAgaWYgKGUuY29kZSAhPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH0pO1xufTtcblxuLy8gSGFuZGxlcyBhbnkgZm9sbG93dXAgbG9naWNcblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlRm9sbG93dXAgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ10gJiYgdGhpcy5jb25maWcucmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCkge1xuICAgIHZhciBzZXNzaW9uUXVlcnkgPSB7XG4gICAgICB1c2VyOiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICB9LFxuICAgIH07XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddO1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmRlc3Ryb3koJ19TZXNzaW9uJywgc2Vzc2lvblF1ZXJ5KVxuICAgICAgLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddO1xuICAgIHJldHVybiB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbigpLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydzZW5kVmVyaWZpY2F0aW9uRW1haWwnXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddO1xuICAgIC8vIEZpcmUgYW5kIGZvcmdldCFcbiAgICB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZW5kVmVyaWZpY2F0aW9uRW1haWwodGhpcy5kYXRhLCB7IGF1dGg6IHRoaXMuYXV0aCB9KTtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfU2Vzc2lvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIF9TZXNzaW9uIG9iamVjdC5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlU2Vzc2lvbiA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5jbGFzc05hbWUgIT09ICdfU2Vzc2lvbicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIXRoaXMuYXV0aC51c2VyICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTiwgJ1Nlc3Npb24gdG9rZW4gcmVxdWlyZWQuJyk7XG4gIH1cblxuICAvLyBUT0RPOiBWZXJpZnkgcHJvcGVyIGVycm9yIHRvIHRocm93XG4gIGlmICgnQUNMJyBpbiB0aGlzLmRhdGEpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0Nhbm5vdCBzZXQgJyArICdBQ0wgb24gYSBTZXNzaW9uLicpO1xuICB9XG5cbiAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICBpZiAoJ3VzZXInIGluIHRoaXMuZGF0YSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmIHRoaXMuZGF0YS51c2VyPy5vYmplY3RJZCAhPT0gdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnSW52YWxpZCBrZXkgbmFtZTogdXNlcicpO1xuICAgIH0gZWxzZSBpZiAoJ2luc3RhbGxhdGlvbklkJyBpbiB0aGlzLmRhdGEpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnSW52YWxpZCBrZXkgbmFtZTogaW5zdGFsbGF0aW9uSWQnKTtcbiAgICB9IGVsc2UgaWYgKCdzZXNzaW9uVG9rZW4nIGluIHRoaXMuZGF0YSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdJbnZhbGlkIGtleSBuYW1lOiBzZXNzaW9uVG9rZW4nKTtcbiAgICB9IGVsc2UgaWYgKCdleHBpcmVzQXQnIGluIHRoaXMuZGF0YSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdJbnZhbGlkIGtleSBuYW1lOiBleHBpcmVzQXQnKTtcbiAgICB9IGVsc2UgaWYgKCdjcmVhdGVkV2l0aCcgaW4gdGhpcy5kYXRhICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0ludmFsaWQga2V5IG5hbWU6IGNyZWF0ZWRXaXRoJyk7XG4gICAgfVxuICAgIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgICB0aGlzLnF1ZXJ5ID0ge1xuICAgICAgICAkYW5kOiBbXG4gICAgICAgICAgdGhpcy5xdWVyeSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB1c2VyOiB7XG4gICAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgICAgICAgIG9iamVjdElkOiB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgY29uc3QgYWRkaXRpb25hbFNlc3Npb25EYXRhID0ge307XG4gICAgZm9yICh2YXIga2V5IGluIHRoaXMuZGF0YSkge1xuICAgICAgaWYgKGtleSA9PT0gJ29iamVjdElkJyB8fCBrZXkgPT09ICd1c2VyJyB8fCBrZXkgPT09ICdzZXNzaW9uVG9rZW4nIHx8IGtleSA9PT0gJ2V4cGlyZXNBdCcgfHwga2V5ID09PSAnY3JlYXRlZFdpdGgnKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYWRkaXRpb25hbFNlc3Npb25EYXRhW2tleV0gPSB0aGlzLmRhdGFba2V5XTtcbiAgICB9XG5cbiAgICBjb25zdCB7IHNlc3Npb25EYXRhLCBjcmVhdGVTZXNzaW9uIH0gPSBSZXN0V3JpdGUuY3JlYXRlU2Vzc2lvbih0aGlzLmNvbmZpZywge1xuICAgICAgdXNlcklkOiB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgIGNyZWF0ZWRXaXRoOiB7XG4gICAgICAgIGFjdGlvbjogJ2NyZWF0ZScsXG4gICAgICB9LFxuICAgICAgYWRkaXRpb25hbFNlc3Npb25EYXRhLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKCFyZXN1bHRzLnJlc3BvbnNlKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsICdFcnJvciBjcmVhdGluZyBzZXNzaW9uLicpO1xuICAgICAgfVxuICAgICAgc2Vzc2lvbkRhdGFbJ29iamVjdElkJ10gPSByZXN1bHRzLnJlc3BvbnNlWydvYmplY3RJZCddO1xuICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgc3RhdHVzOiAyMDEsXG4gICAgICAgIGxvY2F0aW9uOiByZXN1bHRzLmxvY2F0aW9uLFxuICAgICAgICByZXNwb25zZTogc2Vzc2lvbkRhdGEsXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfSW5zdGFsbGF0aW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gaW5zdGFsbGF0aW9uIG9iamVjdC5cbi8vIElmIGFuIGluc3RhbGxhdGlvbiBpcyBmb3VuZCwgdGhpcyBjYW4gbXV0YXRlIHRoaXMucXVlcnkgYW5kIHR1cm4gYSBjcmVhdGVcbi8vIGludG8gYW4gdXBkYXRlLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVJbnN0YWxsYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMuY2xhc3NOYW1lICE9PSAnX0luc3RhbGxhdGlvbicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoXG4gICAgIXRoaXMucXVlcnkgJiZcbiAgICAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICF0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgMTM1LFxuICAgICAgJ2F0IGxlYXN0IG9uZSBJRCBmaWVsZCAoZGV2aWNlVG9rZW4sIGluc3RhbGxhdGlvbklkKSAnICsgJ211c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJ1xuICAgICk7XG4gIH1cblxuICAvLyBJZiB0aGUgZGV2aWNlIHRva2VuIGlzIDY0IGNoYXJhY3RlcnMgbG9uZywgd2UgYXNzdW1lIGl0IGlzIGZvciBpT1NcbiAgLy8gYW5kIGxvd2VyY2FzZSBpdC5cbiAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4ubGVuZ3RoID09IDY0KSB7XG4gICAgdGhpcy5kYXRhLmRldmljZVRva2VuID0gdGhpcy5kYXRhLmRldmljZVRva2VuLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBXZSBsb3dlcmNhc2UgdGhlIGluc3RhbGxhdGlvbklkIGlmIHByZXNlbnRcbiAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCA9IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZC50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgbGV0IGluc3RhbGxhdGlvbklkID0gdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkO1xuXG4gIC8vIElmIGRhdGEuaW5zdGFsbGF0aW9uSWQgaXMgbm90IHNldCBhbmQgd2UncmUgbm90IG1hc3Rlciwgd2UgY2FuIGxvb2t1cCBpbiBhdXRoXG4gIGlmICghaW5zdGFsbGF0aW9uSWQgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICBpbnN0YWxsYXRpb25JZCA9IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuXG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIGluc3RhbGxhdGlvbklkID0gaW5zdGFsbGF0aW9uSWQudG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIC8vIFVwZGF0aW5nIF9JbnN0YWxsYXRpb24gYnV0IG5vdCB1cGRhdGluZyBhbnl0aGluZyBjcml0aWNhbFxuICBpZiAodGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmICFpbnN0YWxsYXRpb25JZCAmJiAhdGhpcy5kYXRhLmRldmljZVR5cGUpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4gIHZhciBpZE1hdGNoOyAvLyBXaWxsIGJlIGEgbWF0Y2ggb24gZWl0aGVyIG9iamVjdElkIG9yIGluc3RhbGxhdGlvbklkXG4gIHZhciBvYmplY3RJZE1hdGNoO1xuICB2YXIgaW5zdGFsbGF0aW9uSWRNYXRjaDtcbiAgdmFyIGRldmljZVRva2VuTWF0Y2hlcyA9IFtdO1xuXG4gIC8vIEluc3RlYWQgb2YgaXNzdWluZyAzIHJlYWRzLCBsZXQncyBkbyBpdCB3aXRoIG9uZSBPUi5cbiAgY29uc3Qgb3JRdWVyaWVzID0gW107XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBvYmplY3RJZDogdGhpcy5xdWVyeS5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBpbnN0YWxsYXRpb25JZDogaW5zdGFsbGF0aW9uSWQsXG4gICAgfSk7XG4gIH1cbiAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgIG9yUXVlcmllcy5wdXNoKHsgZGV2aWNlVG9rZW46IHRoaXMuZGF0YS5kZXZpY2VUb2tlbiB9KTtcbiAgfVxuXG4gIGlmIChvclF1ZXJpZXMubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBwcm9taXNlID0gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAnX0luc3RhbGxhdGlvbicsXG4gICAgICAgIHtcbiAgICAgICAgICAkb3I6IG9yUXVlcmllcyxcbiAgICAgICAgfSxcbiAgICAgICAge31cbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMuZm9yRWFjaChyZXN1bHQgPT4ge1xuICAgICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIHJlc3VsdC5vYmplY3RJZCA9PSB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgb2JqZWN0SWRNYXRjaCA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVzdWx0Lmluc3RhbGxhdGlvbklkID09IGluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgICAgaW5zdGFsbGF0aW9uSWRNYXRjaCA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVzdWx0LmRldmljZVRva2VuID09IHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgICAgICAgIGRldmljZVRva2VuTWF0Y2hlcy5wdXNoKHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICAvLyBTYW5pdHkgY2hlY2tzIHdoZW4gcnVubmluZyBhIHF1ZXJ5XG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgIGlmICghb2JqZWN0SWRNYXRjaCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZCBmb3IgdXBkYXRlLicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICBvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICE9PSBvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsICdpbnN0YWxsYXRpb25JZCBtYXkgbm90IGJlIGNoYW5nZWQgaW4gdGhpcyAnICsgJ29wZXJhdGlvbicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICBvYmplY3RJZE1hdGNoLmRldmljZVRva2VuICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICE9PSBvYmplY3RJZE1hdGNoLmRldmljZVRva2VuICYmXG4gICAgICAgICAgIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgICFvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsICdkZXZpY2VUb2tlbiBtYXkgbm90IGJlIGNoYW5nZWQgaW4gdGhpcyAnICsgJ29wZXJhdGlvbicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgIT09IG9iamVjdElkTWF0Y2guZGV2aWNlVHlwZVxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM2LCAnZGV2aWNlVHlwZSBtYXkgbm90IGJlIGNoYW5nZWQgaW4gdGhpcyAnICsgJ29wZXJhdGlvbicpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQgJiYgb2JqZWN0SWRNYXRjaCkge1xuICAgICAgICBpZE1hdGNoID0gb2JqZWN0SWRNYXRjaDtcbiAgICAgIH1cblxuICAgICAgaWYgKGluc3RhbGxhdGlvbklkICYmIGluc3RhbGxhdGlvbklkTWF0Y2gpIHtcbiAgICAgICAgaWRNYXRjaCA9IGluc3RhbGxhdGlvbklkTWF0Y2g7XG4gICAgICB9XG4gICAgICAvLyBuZWVkIHRvIHNwZWNpZnkgZGV2aWNlVHlwZSBvbmx5IGlmIGl0J3MgbmV3XG4gICAgICBpZiAoIXRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5kZXZpY2VUeXBlICYmICFpZE1hdGNoKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzUsICdkZXZpY2VUeXBlIG11c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJyk7XG4gICAgICB9XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICBpZiAoIWlkTWF0Y2gpIHtcbiAgICAgICAgaWYgKCFkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIGRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGggPT0gMSAmJlxuICAgICAgICAgICghZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydpbnN0YWxsYXRpb25JZCddIHx8ICFpbnN0YWxsYXRpb25JZClcbiAgICAgICAgKSB7XG4gICAgICAgICAgLy8gU2luZ2xlIG1hdGNoIG9uIGRldmljZSB0b2tlbiBidXQgbm9uZSBvbiBpbnN0YWxsYXRpb25JZCwgYW5kIGVpdGhlclxuICAgICAgICAgIC8vIHRoZSBwYXNzZWQgb2JqZWN0IG9yIHRoZSBtYXRjaCBpcyBtaXNzaW5nIGFuIGluc3RhbGxhdGlvbklkLCBzbyB3ZVxuICAgICAgICAgIC8vIGNhbiBqdXN0IHJldHVybiB0aGUgbWF0Y2guXG4gICAgICAgICAgcmV0dXJuIGRldmljZVRva2VuTWF0Y2hlc1swXVsnb2JqZWN0SWQnXTtcbiAgICAgICAgfSBlbHNlIGlmICghdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgMTMyLFxuICAgICAgICAgICAgJ011c3Qgc3BlY2lmeSBpbnN0YWxsYXRpb25JZCB3aGVuIGRldmljZVRva2VuICcgK1xuICAgICAgICAgICAgICAnbWF0Y2hlcyBtdWx0aXBsZSBJbnN0YWxsYXRpb24gb2JqZWN0cydcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIE11bHRpcGxlIGRldmljZSB0b2tlbiBtYXRjaGVzIGFuZCB3ZSBzcGVjaWZpZWQgYW4gaW5zdGFsbGF0aW9uIElELFxuICAgICAgICAgIC8vIG9yIGEgc2luZ2xlIG1hdGNoIHdoZXJlIGJvdGggdGhlIHBhc3NlZCBhbmQgbWF0Y2hpbmcgb2JqZWN0cyBoYXZlXG4gICAgICAgICAgLy8gYW4gaW5zdGFsbGF0aW9uIElELiBDbGVhbiBvdXQgb3RoZXIgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoIHRoZVxuICAgICAgICAgIC8vIGRldmljZVRva2VuLCBhbmQgcmV0dXJuIG5pbCB0byBzaWduYWwgdGhhdCBhIG5ldyBvYmplY3Qgc2hvdWxkIGJlXG4gICAgICAgICAgLy8gY3JlYXRlZC5cbiAgICAgICAgICBjb25zdCBkZWxRdWVyeSA9IHtcbiAgICAgICAgICAgIGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4sXG4gICAgICAgICAgICBpbnN0YWxsYXRpb25JZDoge1xuICAgICAgICAgICAgICAkbmU6IGluc3RhbGxhdGlvbklkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9O1xuICAgICAgICAgIGlmICh0aGlzLmRhdGEuYXBwSWRlbnRpZmllcikge1xuICAgICAgICAgICAgZGVsUXVlcnlbJ2FwcElkZW50aWZpZXInXSA9IHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBpbnN0YWxsYXRpb25PcHRzID0gdGhpcy5jb25maWcuaW5zdGFsbGF0aW9uIHx8IHt9O1xuICAgICAgICAgIHJldHVybiBJbnN0YWxsYXRpb25EZWR1cC5yZW1vdmVDb25mbGljdGluZ0RldmljZVRva2VuKHtcbiAgICAgICAgICAgIGRhdGFiYXNlOiB0aGlzLmNvbmZpZy5kYXRhYmFzZSxcbiAgICAgICAgICAgIHF1ZXJ5OiBkZWxRdWVyeSxcbiAgICAgICAgICAgIGFjdGlvbjogaW5zdGFsbGF0aW9uT3B0cy5kdXBsaWNhdGVEZXZpY2VUb2tlbkFjdGlvbiB8fCAnZGVsZXRlJyxcbiAgICAgICAgICAgIGVuZm9yY2VBdXRoOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGggPT09IHRydWUsXG4gICAgICAgICAgICBydW5PcHRpb25zOiB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmICFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ10pIHtcbiAgICAgICAgICAvLyBFeGFjdGx5IG9uZSBkZXZpY2UgdG9rZW4gbWF0Y2ggYW5kIGl0IGRvZXNuJ3QgaGF2ZSBhbiBpbnN0YWxsYXRpb25cbiAgICAgICAgICAvLyBJRC4gVGhlIHR3byByb3dzIHJlcHJlc2VudCB0aGUgc2FtZSBpbnN0YWxsOyByZXNvbHZlIHRoZSBtZXJnZSBwZXJcbiAgICAgICAgICAvLyB0aGUgY29uZmlndXJlZCBvcHRpb25zLlxuICAgICAgICAgIGNvbnN0IGluc3RhbGxhdGlvbk9wdHMgPSB0aGlzLmNvbmZpZy5pbnN0YWxsYXRpb24gfHwge307XG4gICAgICAgICAgcmV0dXJuIEluc3RhbGxhdGlvbkRlZHVwLmFwcGx5RHVwbGljYXRlRGV2aWNlVG9rZW5NZXJnZSh7XG4gICAgICAgICAgICBkYXRhYmFzZTogdGhpcy5jb25maWcuZGF0YWJhc2UsXG4gICAgICAgICAgICBpZE1hdGNoLFxuICAgICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaDogZGV2aWNlVG9rZW5NYXRjaGVzWzBdLFxuICAgICAgICAgICAgYWN0aW9uOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uIHx8ICdkZWxldGUnLFxuICAgICAgICAgICAgbWVyZ2VQcmlvcml0eTogaW5zdGFsbGF0aW9uT3B0cy5kdXBsaWNhdGVEZXZpY2VUb2tlbk1lcmdlUHJpb3JpdHkgfHwgJ2RldmljZVRva2VuJyxcbiAgICAgICAgICAgIGVuZm9yY2VBdXRoOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGggPT09IHRydWUsXG4gICAgICAgICAgICBydW5PcHRpb25zOiB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiYgaWRNYXRjaC5kZXZpY2VUb2tlbiAhPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICAgICAgICAgIC8vIFdlJ3JlIHNldHRpbmcgdGhlIGRldmljZSB0b2tlbiBvbiBhbiBleGlzdGluZyBpbnN0YWxsYXRpb24sIHNvXG4gICAgICAgICAgICAvLyB3ZSBzaG91bGQgdHJ5IGNsZWFuaW5nIG91dCBvbGQgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoIHRoaXNcbiAgICAgICAgICAgIC8vIGRldmljZSB0b2tlbi5cbiAgICAgICAgICAgIGNvbnN0IGRlbFF1ZXJ5ID0ge1xuICAgICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIC8vIFdlIGhhdmUgYSB1bmlxdWUgaW5zdGFsbCBJZCwgdXNlIHRoYXQgdG8gcHJlc2VydmVcbiAgICAgICAgICAgIC8vIHRoZSBpbnRlcmVzdGluZyBpbnN0YWxsYXRpb25cbiAgICAgICAgICAgIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ2luc3RhbGxhdGlvbklkJ10gPSB7XG4gICAgICAgICAgICAgICAgJG5lOiB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCAmJlxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkID09IHRoaXMuZGF0YS5vYmplY3RJZFxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIC8vIHdlIHBhc3NlZCBhbiBvYmplY3RJZCwgcHJlc2VydmUgdGhhdCBpbnN0YWxhdGlvblxuICAgICAgICAgICAgICBkZWxRdWVyeVsnb2JqZWN0SWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IGlkTWF0Y2gub2JqZWN0SWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBXaGF0IHRvIGRvIGhlcmU/IGNhbid0IHJlYWxseSBjbGVhbiB1cCBldmVyeXRoaW5nLi4uXG4gICAgICAgICAgICAgIHJldHVybiBpZE1hdGNoLm9iamVjdElkO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyKSB7XG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGluc3RhbGxhdGlvbk9wdHMgPSB0aGlzLmNvbmZpZy5pbnN0YWxsYXRpb24gfHwge307XG4gICAgICAgICAgICByZXR1cm4gSW5zdGFsbGF0aW9uRGVkdXAucmVtb3ZlQ29uZmxpY3RpbmdEZXZpY2VUb2tlbih7XG4gICAgICAgICAgICAgIGRhdGFiYXNlOiB0aGlzLmNvbmZpZy5kYXRhYmFzZSxcbiAgICAgICAgICAgICAgcXVlcnk6IGRlbFF1ZXJ5LFxuICAgICAgICAgICAgICBhY3Rpb246IGluc3RhbGxhdGlvbk9wdHMuZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24gfHwgJ2RlbGV0ZScsXG4gICAgICAgICAgICAgIGVuZm9yY2VBdXRoOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGggPT09IHRydWUsXG4gICAgICAgICAgICAgIHJ1bk9wdGlvbnM6IHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICAgICAgdmFsaWRTY2hlbWFDb250cm9sbGVyOiB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgIH0pLnRoZW4oKCkgPT4gaWRNYXRjaC5vYmplY3RJZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEluIG5vbi1tZXJnZSBzY2VuYXJpb3MsIGp1c3QgcmV0dXJuIHRoZSBpbnN0YWxsYXRpb24gbWF0Y2ggaWRcbiAgICAgICAgICByZXR1cm4gaWRNYXRjaC5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4ob2JqSWQgPT4ge1xuICAgICAgaWYgKG9iaklkKSB7XG4gICAgICAgIHRoaXMucXVlcnkgPSB7IG9iamVjdElkOiBvYmpJZCB9O1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcbiAgICAgIH1cbiAgICAgIC8vIFRPRE86IFZhbGlkYXRlIG9wcyAoYWRkL3JlbW92ZSBvbiBjaGFubmVscywgJGluYyBvbiBiYWRnZSwgZXRjLilcbiAgICB9KTtcbiAgcmV0dXJuIHByb21pc2U7XG59O1xuXG4vLyBJZiB3ZSBzaG9ydC1jaXJjdWl0ZWQgdGhlIG9iamVjdCByZXNwb25zZSAtIHRoZW4gd2UgbmVlZCB0byBtYWtlIHN1cmUgd2UgZXhwYW5kIGFsbCB0aGUgZmlsZXMsXG4vLyBzaW5jZSB0aGlzIG1pZ2h0IG5vdCBoYXZlIGEgcXVlcnksIG1lYW5pbmcgaXQgd29uJ3QgcmV0dXJuIHRoZSBmdWxsIHJlc3VsdCBiYWNrLlxuLy8gVE9ETzogKG5sdXRzZW5rbykgVGhpcyBzaG91bGQgZGllIHdoZW4gd2UgbW92ZSB0byBwZXItY2xhc3MgYmFzZWQgY29udHJvbGxlcnMgb24gX1Nlc3Npb24vX1VzZXJcblJlc3RXcml0ZS5wcm90b3R5cGUuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIC8vIENoZWNrIHdoZXRoZXIgd2UgaGF2ZSBhIHNob3J0LWNpcmN1aXRlZCByZXNwb25zZSAtIG9ubHkgdGhlbiBydW4gZXhwYW5zaW9uLlxuICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgYXdhaXQgdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QodGhpcy5jb25maWcsIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpO1xuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkRhdGFiYXNlT3BlcmF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Sb2xlJykge1xuICAgIGlmICh0aGlzLmRhdGEgJiYgdGhpcy5kYXRhLnVzZXJzICYmIHRoaXMuZGF0YS51c2Vycy5vYmplY3RzKSB7XG4gICAgICB0aGlzLmRhdGEudXNlcnMub2JqZWN0cy5mb3JFYWNoKCh7IG9iamVjdElkIH0pID0+IHRoaXMuY29uZmlnLmNhY2hlQ29udHJvbGxlci5yb2xlLmRlbChvYmplY3RJZCkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmNvbmZpZy5jYWNoZUNvbnRyb2xsZXIucm9sZS5jbGVhcigpO1xuICAgICAgaWYgKHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIpIHtcbiAgICAgICAgdGhpcy5jb25maWcubGl2ZVF1ZXJ5Q29udHJvbGxlci5jbGVhckNhY2hlZFJvbGVzKHRoaXMuYXV0aC51c2VyKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiYgdGhpcy5xdWVyeSAmJiB0aGlzLmF1dGguaXNVbmF1dGhlbnRpY2F0ZWQoKSkge1xuICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuU0VTU0lPTl9NSVNTSU5HLFxuICAgICAgYENhbm5vdCBtb2RpZnkgdXNlciAke3RoaXMucXVlcnkub2JqZWN0SWR9LmAsXG4gICAgICB0aGlzLmNvbmZpZ1xuICAgICk7XG4gIH1cblxuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfUHJvZHVjdCcgJiYgdGhpcy5kYXRhLmRvd25sb2FkKSB7XG4gICAgdGhpcy5kYXRhLmRvd25sb2FkTmFtZSA9IHRoaXMuZGF0YS5kb3dubG9hZC5uYW1lO1xuICB9XG5cbiAgLy8gVE9ETzogQWRkIGJldHRlciBkZXRlY3Rpb24gZm9yIEFDTCwgZW5zdXJpbmcgYSB1c2VyIGNhbid0IGJlIGxvY2tlZCBmcm9tXG4gIC8vICAgICAgIHRoZWlyIG93biB1c2VyIHJlY29yZC5cbiAgaWYgKHRoaXMuZGF0YS5BQ0wgJiYgdGhpcy5kYXRhLkFDTFsnKnVucmVzb2x2ZWQnXSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0FDTCwgJ0ludmFsaWQgQUNMLicpO1xuICB9XG5cbiAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICAvLyBGb3JjZSB0aGUgdXNlciB0byBub3QgbG9ja291dFxuICAgIC8vIE1hdGNoZWQgd2l0aCBwYXJzZS5jb21cbiAgICBpZiAoXG4gICAgICB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICAgdGhpcy5kYXRhLkFDTCAmJlxuICAgICAgdGhpcy5hdXRoLmlzTWFzdGVyICE9PSB0cnVlICYmXG4gICAgICB0aGlzLmF1dGguaXNNYWludGVuYW5jZSAhPT0gdHJ1ZVxuICAgICkge1xuICAgICAgdGhpcy5kYXRhLkFDTFt0aGlzLnF1ZXJ5Lm9iamVjdElkXSA9IHsgcmVhZDogdHJ1ZSwgd3JpdGU6IHRydWUgfTtcbiAgICB9XG4gICAgLy8gdXBkYXRlIHBhc3N3b3JkIHRpbWVzdGFtcCBpZiB1c2VyIHBhc3N3b3JkIGlzIGJlaW5nIGNoYW5nZWRcbiAgICBpZiAoXG4gICAgICB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICAgdGhpcy5kYXRhLl9oYXNoZWRfcGFzc3dvcmQgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZVxuICAgICkge1xuICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICB9XG4gICAgLy8gSWdub3JlIGNyZWF0ZWRBdCB3aGVuIHVwZGF0ZVxuICAgIGRlbGV0ZSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgbGV0IGRlZmVyID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgLy8gaWYgcGFzc3dvcmQgaGlzdG9yeSBpcyBlbmFibGVkIHRoZW4gc2F2ZSB0aGUgY3VycmVudCBwYXNzd29yZCB0byBoaXN0b3J5XG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5XG4gICAgKSB7XG4gICAgICBkZWZlciA9IHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgIC5maW5kKFxuICAgICAgICAgICdfVXNlcicsXG4gICAgICAgICAgeyBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgICAgeyBrZXlzOiBbJ19wYXNzd29yZF9oaXN0b3J5JywgJ19oYXNoZWRfcGFzc3dvcmQnXSB9LFxuICAgICAgICAgIEF1dGgubWFpbnRlbmFuY2UodGhpcy5jb25maWcpXG4gICAgICAgIClcbiAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICAgIHRocm93IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgICAgbGV0IG9sZFBhc3N3b3JkcyA9IFtdO1xuICAgICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KSB7XG4gICAgICAgICAgICBvbGRQYXNzd29yZHMgPSBfLnRha2UoXG4gICAgICAgICAgICAgIHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksXG4gICAgICAgICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy9uLTEgcGFzc3dvcmRzIGdvIGludG8gaGlzdG9yeSBpbmNsdWRpbmcgbGFzdCBwYXNzd29yZFxuICAgICAgICAgIHdoaWxlIChcbiAgICAgICAgICAgIG9sZFBhc3N3b3Jkcy5sZW5ndGggPiBNYXRoLm1heCgwLCB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgLSAyKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgb2xkUGFzc3dvcmRzLnNoaWZ0KCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG9sZFBhc3N3b3Jkcy5wdXNoKHVzZXIucGFzc3dvcmQpO1xuICAgICAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfaGlzdG9yeSA9IG9sZFBhc3N3b3JkcztcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRlZmVyLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gUnVuIGFuIHVwZGF0ZVxuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgIC51cGRhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5xdWVyeSxcbiAgICAgICAgICB0aGlzLmRhdGEsXG4gICAgICAgICAgdGhpcy5ydW5PcHRpb25zLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgICAgIClcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICB0aGlzLl90aHJvd0lmQXV0aERhdGFEdXBsaWNhdGUoZXJyb3IpO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgICAgcmVzcG9uc2UudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgICAgdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShyZXNwb25zZSwgdGhpcy5kYXRhKTtcbiAgICAgICAgICB0aGlzLnJlc3BvbnNlID0geyByZXNwb25zZSB9O1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICAvLyBTZXQgdGhlIGRlZmF1bHQgQUNMIGFuZCBwYXNzd29yZCB0aW1lc3RhbXAgZm9yIHRoZSBuZXcgX1VzZXJcbiAgICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAgIHZhciBBQ0wgPSB0aGlzLmRhdGEuQUNMO1xuICAgICAgLy8gZGVmYXVsdCBwdWJsaWMgci93IEFDTFxuICAgICAgaWYgKCFBQ0wpIHtcbiAgICAgICAgQUNMID0ge307XG4gICAgICAgIGlmICghdGhpcy5jb25maWcuZW5mb3JjZVByaXZhdGVVc2Vycykge1xuICAgICAgICAgIEFDTFsnKiddID0geyByZWFkOiB0cnVlLCB3cml0ZTogZmFsc2UgfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gbWFrZSBzdXJlIHRoZSB1c2VyIGlzIG5vdCBsb2NrZWQgZG93blxuICAgICAgQUNMW3RoaXMuZGF0YS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgICB0aGlzLmRhdGEuQUNMID0gQUNMO1xuICAgICAgLy8gcGFzc3dvcmQgdGltZXN0YW1wIHRvIGJlIHVzZWQgd2hlbiBwYXNzd29yZCBleHBpcnkgcG9saWN5IGlzIGVuZm9yY2VkXG4gICAgICBpZiAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiYgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UpIHtcbiAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSdW4gYSBjcmVhdGVcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5jcmVhdGUodGhpcy5jbGFzc05hbWUsIHRoaXMuZGF0YSwgdGhpcy5ydW5PcHRpb25zLCBmYWxzZSwgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicgfHwgZXJyb3IuY29kZSAhPT0gUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLl90aHJvd0lmQXV0aERhdGFEdXBsaWNhdGUoZXJyb3IpO1xuXG4gICAgICAgIC8vIFF1aWNrIGNoZWNrLCBpZiB3ZSB3ZXJlIGFibGUgdG8gaW5mZXIgdGhlIGR1cGxpY2F0ZWQgZmllbGQgbmFtZVxuICAgICAgICBpZiAoZXJyb3IgJiYgZXJyb3IudXNlckluZm8gJiYgZXJyb3IudXNlckluZm8uZHVwbGljYXRlZF9maWVsZCA9PT0gJ3VzZXJuYW1lJykge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOLFxuICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZXJyb3IgJiYgZXJyb3IudXNlckluZm8gJiYgZXJyb3IudXNlckluZm8uZHVwbGljYXRlZF9maWVsZCA9PT0gJ2VtYWlsJykge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIElmIHRoaXMgd2FzIGEgZmFpbGVkIHVzZXIgY3JlYXRpb24gZHVlIHRvIHVzZXJuYW1lIG9yIGVtYWlsIGFscmVhZHkgdGFrZW4sIHdlIG5lZWQgdG9cbiAgICAgICAgLy8gY2hlY2sgd2hldGhlciBpdCB3YXMgdXNlcm5hbWUgb3IgZW1haWwgYW5kIHJldHVybiB0aGUgYXBwcm9wcmlhdGUgZXJyb3IuXG4gICAgICAgIC8vIEZhbGxiYWNrIHRvIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICAgICAgLy8gVE9ETzogU2VlIGlmIHdlIGNhbiBsYXRlciBkbyB0aGlzIHdpdGhvdXQgYWRkaXRpb25hbCBxdWVyaWVzIGJ5IHVzaW5nIG5hbWVkIGluZGV4ZXMuXG4gICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAgIC5maW5kKFxuICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHVzZXJuYW1lOiB0aGlzLmRhdGEudXNlcm5hbWUsXG4gICAgICAgICAgICAgIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgeyBsaW1pdDogMSB9XG4gICAgICAgICAgKVxuICAgICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfVEFLRU4sXG4gICAgICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgICAgICB7IGVtYWlsOiB0aGlzLmRhdGEuZW1haWwsIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0gfSxcbiAgICAgICAgICAgICAgeyBsaW1pdDogMSB9XG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgICAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgICByZXNwb25zZS5vYmplY3RJZCA9IHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgcmVzcG9uc2UuY3JlYXRlZEF0ID0gdGhpcy5kYXRhLmNyZWF0ZWRBdDtcblxuICAgICAgICBpZiAodGhpcy5yZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSkge1xuICAgICAgICAgIHJlc3BvbnNlLnVzZXJuYW1lID0gdGhpcy5kYXRhLnVzZXJuYW1lO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEocmVzcG9uc2UsIHRoaXMuZGF0YSk7XG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgICAgc3RhdHVzOiAyMDEsXG4gICAgICAgICAgcmVzcG9uc2UsXG4gICAgICAgICAgbG9jYXRpb246IHRoaXMubG9jYXRpb24oKSxcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICB9XG59O1xuXG4vLyBSZXR1cm5zIG5vdGhpbmcgLSBkb2Vzbid0IHdhaXQgZm9yIHRoZSB0cmlnZ2VyLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5BZnRlclNhdmVUcmlnZ2VyID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMucmVzcG9uc2UgfHwgIXRoaXMucmVzcG9uc2UucmVzcG9uc2UgfHwgdGhpcy5ydW5PcHRpb25zLm1hbnkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdhZnRlclNhdmUnIHRyaWdnZXIgZm9yIHRoaXMgY2xhc3MuXG4gIGNvbnN0IGhhc0FmdGVyU2F2ZUhvb2sgPSB0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRyaWdnZXJzLlR5cGVzLmFmdGVyU2F2ZSxcbiAgICB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkXG4gICk7XG4gIGNvbnN0IGhhc0xpdmVRdWVyeSA9IHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIuaGFzTGl2ZVF1ZXJ5KHRoaXMuY2xhc3NOYW1lKTtcbiAgaWYgKCFoYXNBZnRlclNhdmVIb29rICYmICFoYXNMaXZlUXVlcnkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjb25zdCB7IG9yaWdpbmFsT2JqZWN0LCB1cGRhdGVkT2JqZWN0IH0gPSB0aGlzLmJ1aWxkUGFyc2VPYmplY3RzKCk7XG4gIHVwZGF0ZWRPYmplY3QuX2hhbmRsZVNhdmVSZXNwb25zZSh0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLCB0aGlzLnJlc3BvbnNlLnN0YXR1cyB8fCAyMDApO1xuXG4gIGlmIChoYXNMaXZlUXVlcnkpIHtcbiAgICB0aGlzLmNvbmZpZy5kYXRhYmFzZS5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgIC8vIE5vdGlmeSBMaXZlUXVlcnlTZXJ2ZXIgaWYgcG9zc2libGVcbiAgICAgIGNvbnN0IHBlcm1zID0gc2NoZW1hQ29udHJvbGxlci5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnModXBkYXRlZE9iamVjdC5jbGFzc05hbWUpO1xuICAgICAgdGhpcy5jb25maWcubGl2ZVF1ZXJ5Q29udHJvbGxlci5vbkFmdGVyU2F2ZShcbiAgICAgICAgdXBkYXRlZE9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgIHVwZGF0ZWRPYmplY3QsXG4gICAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgICBwZXJtc1xuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuICBpZiAoIWhhc0FmdGVyU2F2ZUhvb2spIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gUnVuIGFmdGVyU2F2ZSB0cmlnZ2VyXG4gIHJldHVybiB0cmlnZ2Vyc1xuICAgIC5tYXliZVJ1blRyaWdnZXIoXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgb3JpZ2luYWxPYmplY3QsXG4gICAgICB0aGlzLmNvbmZpZyxcbiAgICAgIHRoaXMuY29udGV4dFxuICAgIClcbiAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgY29uc3QganNvblJldHVybmVkID0gcmVzdWx0ICYmICFyZXN1bHQuX3RvRnVsbEpTT047XG4gICAgICBpZiAoanNvblJldHVybmVkKSB7XG4gICAgICAgIHRoaXMucGVuZGluZ09wcy5vcGVyYXRpb25zID0ge307XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UgPSByZXN1bHQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlID0gdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShcbiAgICAgICAgICAocmVzdWx0IHx8IHVwZGF0ZWRPYmplY3QpLnRvSlNPTigpLFxuICAgICAgICAgIHRoaXMuZGF0YVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pXG4gICAgLmNhdGNoKGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgIGxvZ2dlci53YXJuKCdhZnRlclNhdmUgY2F1Z2h0IGFuIGVycm9yJywgZXJyKTtcbiAgICB9KTtcbn07XG5cbi8vIEEgaGVscGVyIHRvIGZpZ3VyZSBvdXQgd2hhdCBsb2NhdGlvbiB0aGlzIG9wZXJhdGlvbiBoYXBwZW5zIGF0LlxuUmVzdFdyaXRlLnByb3RvdHlwZS5sb2NhdGlvbiA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG1pZGRsZSA9IHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInID8gJy91c2Vycy8nIDogJy9jbGFzc2VzLycgKyB0aGlzLmNsYXNzTmFtZSArICcvJztcbiAgY29uc3QgbW91bnQgPSB0aGlzLmNvbmZpZy5tb3VudCB8fCB0aGlzLmNvbmZpZy5zZXJ2ZXJVUkw7XG4gIHJldHVybiBtb3VudCArIG1pZGRsZSArIHRoaXMuZGF0YS5vYmplY3RJZDtcbn07XG5cbi8vIEEgaGVscGVyIHRvIGdldCB0aGUgb2JqZWN0IGlkIGZvciB0aGlzIG9wZXJhdGlvbi5cbi8vIEJlY2F1c2UgaXQgY291bGQgYmUgZWl0aGVyIG9uIHRoZSBxdWVyeSBvciBvbiB0aGUgZGF0YVxuUmVzdFdyaXRlLnByb3RvdHlwZS5vYmplY3RJZCA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuZGF0YS5vYmplY3RJZCB8fCB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xufTtcblxuLy8gUmV0dXJucyBhIGNvcHkgb2YgdGhlIGRhdGEgYW5kIGRlbGV0ZSBiYWQga2V5cyAoX2F1dGhfZGF0YSwgX2hhc2hlZF9wYXNzd29yZC4uLilcblJlc3RXcml0ZS5wcm90b3R5cGUuc2FuaXRpemVkRGF0YSA9IGZ1bmN0aW9uICgpIHtcbiAgY29uc3QgZGF0YSA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YSkucmVkdWNlKChkYXRhLCBrZXkpID0+IHtcbiAgICAvLyBSZWdleHAgY29tZXMgZnJvbSBQYXJzZS5PYmplY3QucHJvdG90eXBlLnZhbGlkYXRlXG4gICAgaWYgKCEvXltBLVphLXpdWzAtOUEtWmEtel9dKiQvLnRlc3Qoa2V5KSkge1xuICAgICAgZGVsZXRlIGRhdGFba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIGRhdGE7XG4gIH0sIHN0cnVjdHVyZWRDbG9uZSh0aGlzLmRhdGEpKTtcbiAgcmV0dXJuIFBhcnNlLl9kZWNvZGUodW5kZWZpbmVkLCBkYXRhKTtcbn07XG5cbi8vIFJldHVybnMgYW4gdXBkYXRlZCBjb3B5IG9mIHRoZSBvYmplY3RcblJlc3RXcml0ZS5wcm90b3R5cGUuYnVpbGRQYXJzZU9iamVjdHMgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IGV4dHJhRGF0YSA9IHsgY2xhc3NOYW1lOiB0aGlzLmNsYXNzTmFtZSwgb2JqZWN0SWQ6IHRoaXMucXVlcnk/Lm9iamVjdElkIH07XG4gIGxldCBvcmlnaW5hbE9iamVjdDtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIG9yaWdpbmFsT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgfVxuXG4gIGNvbnN0IGNsYXNzTmFtZSA9IFBhcnNlLk9iamVjdC5mcm9tSlNPTihleHRyYURhdGEpO1xuICBjb25zdCByZWFkT25seUF0dHJpYnV0ZXMgPSBjbGFzc05hbWUuY29uc3RydWN0b3IucmVhZE9ubHlBdHRyaWJ1dGVzXG4gICAgPyBjbGFzc05hbWUuY29uc3RydWN0b3IucmVhZE9ubHlBdHRyaWJ1dGVzKClcbiAgICA6IFtdO1xuXG4gIC8vIEZvciBfUm9sZSBjbGFzcywgJ25hbWUnIGNhbm5vdCBiZSBzZXQgYWZ0ZXIgdGhlIHJvbGUgaGFzIGFuIG9iamVjdElkLlxuICAvLyBJbiBhZnRlclNhdmUgY29udGV4dCwgX2hhbmRsZVNhdmVSZXNwb25zZSBoYXMgYWxyZWFkeSBzZXQgdGhlIG9iamVjdElkLFxuICAvLyBzbyB3ZSB0cmVhdCAnbmFtZScgYXMgcmVhZC1vbmx5IHRvIGF2b2lkIFBhcnNlIFNESyB2YWxpZGF0aW9uIGVycm9ycy5cbiAgY29uc3QgaXNSb2xlQWZ0ZXJTYXZlID0gdGhpcy5jbGFzc05hbWUgPT09ICdfUm9sZScgJiYgdGhpcy5yZXNwb25zZSAmJiAhdGhpcy5xdWVyeTtcbiAgaWYgKGlzUm9sZUFmdGVyU2F2ZSAmJiB0aGlzLmRhdGEubmFtZSAmJiAhcmVhZE9ubHlBdHRyaWJ1dGVzLmluY2x1ZGVzKCduYW1lJykpIHtcbiAgICByZWFkT25seUF0dHJpYnV0ZXMucHVzaCgnbmFtZScpO1xuICB9XG4gIGlmICghdGhpcy5vcmlnaW5hbERhdGEpIHtcbiAgICBmb3IgKGNvbnN0IGF0dHJpYnV0ZSBvZiByZWFkT25seUF0dHJpYnV0ZXMpIHtcbiAgICAgIGV4dHJhRGF0YVthdHRyaWJ1dGVdID0gdGhpcy5kYXRhW2F0dHJpYnV0ZV07XG4gICAgfVxuICB9XG4gIGNvbnN0IHVwZGF0ZWRPYmplY3QgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdGhpcy5vcmlnaW5hbERhdGEpO1xuICBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLnJlZHVjZShmdW5jdGlvbiAoZGF0YSwga2V5KSB7XG4gICAgaWYgKGtleS5pbmRleE9mKCcuJykgPiAwKSB7XG4gICAgICBpZiAodHlwZW9mIGRhdGFba2V5XS5fX29wID09PSAnc3RyaW5nJykge1xuICAgICAgICBpZiAoIXJlYWRPbmx5QXR0cmlidXRlcy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICAgICAgdXBkYXRlZE9iamVjdC5zZXQoa2V5LCBkYXRhW2tleV0pO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBzdWJkb2N1bWVudCBrZXkgd2l0aCBkb3Qgbm90YXRpb24geyAneC55JzogdiB9ID0+IHsgJ3gnOiB7ICd5JyA6IHYgfSB9KVxuICAgICAgICBjb25zdCBzcGxpdHRlZEtleSA9IGtleS5zcGxpdCgnLicpO1xuICAgICAgICBjb25zdCBwYXJlbnRQcm9wID0gc3BsaXR0ZWRLZXlbMF07XG4gICAgICAgIGxldCBwYXJlbnRWYWwgPSB1cGRhdGVkT2JqZWN0LmdldChwYXJlbnRQcm9wKTtcbiAgICAgICAgaWYgKHR5cGVvZiBwYXJlbnRWYWwgIT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgcGFyZW50VmFsID0ge307XG4gICAgICAgIH1cbiAgICAgICAgcGFyZW50VmFsW3NwbGl0dGVkS2V5WzFdXSA9IGRhdGFba2V5XTtcbiAgICAgICAgdXBkYXRlZE9iamVjdC5zZXQocGFyZW50UHJvcCwgcGFyZW50VmFsKTtcbiAgICAgIH1cbiAgICAgIGRlbGV0ZSBkYXRhW2tleV07XG4gICAgfVxuICAgIHJldHVybiBkYXRhO1xuICB9LCBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5kYXRhKSk7XG5cbiAgY29uc3Qgc2FuaXRpemVkID0gdGhpcy5zYW5pdGl6ZWREYXRhKCk7XG4gIGZvciAoY29uc3QgYXR0cmlidXRlIG9mIHJlYWRPbmx5QXR0cmlidXRlcykge1xuICAgIGRlbGV0ZSBzYW5pdGl6ZWRbYXR0cmlidXRlXTtcbiAgfVxuICB1cGRhdGVkT2JqZWN0LnNldChzYW5pdGl6ZWQpO1xuICByZXR1cm4geyB1cGRhdGVkT2JqZWN0LCBvcmlnaW5hbE9iamVjdCB9O1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jbGVhblVzZXJBdXRoRGF0YSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSAmJiB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIGNvbnN0IHVzZXIgPSB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlO1xuICAgIGlmICh1c2VyLmF1dGhEYXRhKSB7XG4gICAgICBPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgICAgaWYgKHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdID09PSBudWxsKSB7XG4gICAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGlmIChPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5sZW5ndGggPT0gMCkge1xuICAgICAgICBkZWxldGUgdXNlci5hdXRoRGF0YTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cbi8vIFN0cmlwcyBwcm90ZWN0ZWQgZmllbGRzIGZyb20gdGhlIHdyaXRlIHJlc3BvbnNlIHdoZW4gcHJvdGVjdGVkRmllbGRzU2F2ZVJlc3BvbnNlRXhlbXB0IGlzIGZhbHNlLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5maWx0ZXJQcm90ZWN0ZWRGaWVsZHNJblJlc3BvbnNlID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jb25maWcucHJvdGVjdGVkRmllbGRzU2F2ZVJlc3BvbnNlRXhlbXB0ICE9PSBmYWxzZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghdGhpcy5yZXNwb25zZSB8fCAhdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBzY2hlbWFDb250cm9sbGVyID0gYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UubG9hZFNjaGVtYSgpO1xuICBjb25zdCBwcm90ZWN0ZWRGaWVsZHMgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS5hZGRQcm90ZWN0ZWRGaWVsZHMoXG4gICAgc2NoZW1hQ29udHJvbGxlcixcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0aGlzLnF1ZXJ5ID8geyBvYmplY3RJZDogdGhpcy5xdWVyeS5vYmplY3RJZCB9IDoge30sXG4gICAgdGhpcy5hdXRoLnVzZXIgPyBbdGhpcy5hdXRoLnVzZXIuaWRdLmNvbmNhdCh0aGlzLmF1dGgudXNlclJvbGVzIHx8IFtdKSA6IFtdLFxuICAgIHRoaXMuYXV0aCxcbiAgICB7fVxuICApO1xuICBpZiAoIXByb3RlY3RlZEZpZWxkcykge1xuICAgIHJldHVybjtcbiAgfVxuICBmb3IgKGNvbnN0IGZpZWxkIG9mIHByb3RlY3RlZEZpZWxkcykge1xuICAgIGRlbGV0ZSB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlW2ZpZWxkXTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSA9IGZ1bmN0aW9uIChyZXNwb25zZSwgZGF0YSkge1xuICBjb25zdCBzdGF0ZUNvbnRyb2xsZXIgPSBQYXJzZS5Db3JlTWFuYWdlci5nZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIoKTtcbiAgY29uc3QgW3BlbmRpbmddID0gc3RhdGVDb250cm9sbGVyLmdldFBlbmRpbmdPcHModGhpcy5wZW5kaW5nT3BzLmlkZW50aWZpZXIpO1xuICBmb3IgKGNvbnN0IGtleSBpbiB0aGlzLnBlbmRpbmdPcHMub3BlcmF0aW9ucykge1xuICAgIGlmICghcGVuZGluZ1trZXldKSB7XG4gICAgICBkYXRhW2tleV0gPSB0aGlzLm9yaWdpbmFsRGF0YSA/IHRoaXMub3JpZ2luYWxEYXRhW2tleV0gOiB7IF9fb3A6ICdEZWxldGUnIH07XG4gICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5wdXNoKGtleSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHNraXBLZXlzID0gWy4uLihyZXF1aXJlZENvbHVtbnMucmVhZFt0aGlzLmNsYXNzTmFtZV0gfHwgW10pXTtcbiAgaWYgKCF0aGlzLnF1ZXJ5KSB7XG4gICAgc2tpcEtleXMucHVzaCgnb2JqZWN0SWQnLCAnY3JlYXRlZEF0Jyk7XG4gIH0gZWxzZSB7XG4gICAgc2tpcEtleXMucHVzaCgndXBkYXRlZEF0Jyk7XG4gICAgZGVsZXRlIHJlc3BvbnNlLm9iamVjdElkO1xuICB9XG4gIGZvciAoY29uc3Qga2V5IGluIHJlc3BvbnNlKSB7XG4gICAgaWYgKHNraXBLZXlzLmluY2x1ZGVzKGtleSkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCB2YWx1ZSA9IHJlc3BvbnNlW2tleV07XG4gICAgaWYgKFxuICAgICAgdmFsdWUgPT0gbnVsbCB8fFxuICAgICAgKHZhbHVlLl9fdHlwZSAmJiB2YWx1ZS5fX3R5cGUgPT09ICdQb2ludGVyJykgfHxcbiAgICAgIHV0aWwuaXNEZWVwU3RyaWN0RXF1YWwoZGF0YVtrZXldLCB2YWx1ZSkgfHxcbiAgICAgIHV0aWwuaXNEZWVwU3RyaWN0RXF1YWwoKHRoaXMub3JpZ2luYWxEYXRhIHx8IHt9KVtrZXldLCB2YWx1ZSlcbiAgICApIHtcbiAgICAgIGRlbGV0ZSByZXNwb25zZVtrZXldO1xuICAgIH1cbiAgfVxuICBpZiAoXy5pc0VtcHR5KHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyKSkge1xuICAgIHJldHVybiByZXNwb25zZTtcbiAgfVxuICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgY29uc3QgZGF0YVZhbHVlID0gZGF0YVtmaWVsZE5hbWVdO1xuXG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVzcG9uc2UsIGZpZWxkTmFtZSkpIHtcbiAgICAgIHJlc3BvbnNlW2ZpZWxkTmFtZV0gPSBkYXRhVmFsdWU7XG4gICAgfVxuXG4gICAgaWYgKHJlc3BvbnNlW2ZpZWxkTmFtZV0gJiYgcmVzcG9uc2VbZmllbGROYW1lXS5fX29wKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2VbZmllbGROYW1lXTtcbiAgICAgIGlmIChkYXRhVmFsdWUuX19vcCA9PSAnRGVsZXRlJykge1xuICAgICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiByZXNwb25zZTtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IFJlc3RXcml0ZTtcbm1vZHVsZS5leHBvcnRzID0gUmVzdFdyaXRlO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFhQSxJQUFBQSxVQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRSxPQUFBLEdBQUFILHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRyxpQkFBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksTUFBQSxHQUFBSixPQUFBO0FBQ0EsSUFBQUssYUFBQSxHQUFBTCxPQUFBO0FBQ0EsSUFBQU0saUJBQUEsR0FBQUMsdUJBQUEsQ0FBQVAsT0FBQTtBQUF5RCxTQUFBTyx3QkFBQUMsQ0FBQSxFQUFBQyxDQUFBLDZCQUFBQyxPQUFBLE1BQUFDLENBQUEsT0FBQUQsT0FBQSxJQUFBRSxDQUFBLE9BQUFGLE9BQUEsWUFBQUgsdUJBQUEsWUFBQUEsQ0FBQUMsQ0FBQSxFQUFBQyxDQUFBLFNBQUFBLENBQUEsSUFBQUQsQ0FBQSxJQUFBQSxDQUFBLENBQUFLLFVBQUEsU0FBQUwsQ0FBQSxNQUFBTSxDQUFBLEVBQUFDLENBQUEsRUFBQUMsQ0FBQSxLQUFBQyxTQUFBLFFBQUFDLE9BQUEsRUFBQVYsQ0FBQSxpQkFBQUEsQ0FBQSx1QkFBQUEsQ0FBQSx5QkFBQUEsQ0FBQSxTQUFBUSxDQUFBLE1BQUFG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LE1BQU1ELEtBQUssR0FBRy9FLFFBQVEsQ0FBQ2dGLEdBQUcsQ0FBQztJQUMzQixJQUNFRCxLQUFLLElBQUksSUFBSSxJQUNaQSxLQUFLLENBQUNtQyxNQUFNLElBQUluQyxLQUFLLENBQUNtQyxNQUFNLEtBQUssU0FBVSxJQUM1Q3hJLElBQUksQ0FBQ29XLGlCQUFpQixDQUFDOVYsSUFBSSxDQUFDZ0csR0FBRyxDQUFDLEVBQUVELEtBQUssQ0FBQyxJQUN4Q3JHLElBQUksQ0FBQ29XLGlCQUFpQixDQUFDLENBQUMsSUFBSSxDQUFDN1YsWUFBWSxJQUFJLENBQUMsQ0FBQyxFQUFFK0YsR0FBRyxDQUFDLEVBQUVELEtBQUssQ0FBQyxFQUM3RDtNQUNBLE9BQU8vRSxRQUFRLENBQUNnRixHQUFHLENBQUM7SUFDdEI7RUFDRjtFQUNBLElBQUlILGVBQUMsQ0FBQ2tELE9BQU8sQ0FBQyxJQUFJLENBQUN2SSxPQUFPLENBQUNvRixzQkFBc0IsQ0FBQyxFQUFFO0lBQ2xELE9BQU81RSxRQUFRO0VBQ2pCO0VBQ0EsSUFBSSxDQUFDUixPQUFPLENBQUNvRixzQkFBc0IsQ0FBQzBDLE9BQU8sQ0FBQ3BCLFNBQVMsSUFBSTtJQUN2RCxNQUFNNk8sU0FBUyxHQUFHL1YsSUFBSSxDQUFDa0gsU0FBUyxDQUFDO0lBRWpDLElBQUksQ0FBQ2xJLE1BQU0sQ0FBQzJCLFNBQVMsQ0FBQzdCLGNBQWMsQ0FBQ0MsSUFBSSxDQUFDaUMsUUFBUSxFQUFFa0csU0FBUyxDQUFDLEVBQUU7TUFDOURsRyxRQUFRLENBQUNrRyxTQUFTLENBQUMsR0FBRzZPLFNBQVM7SUFDakM7SUFFQSxJQUFJL1UsUUFBUSxDQUFDa0csU0FBUyxDQUFDLElBQUlsRyxRQUFRLENBQUNrRyxTQUFTLENBQUMsQ0FBQ0csSUFBSSxFQUFFO01BQ25ELE9BQU9yRyxRQUFRLENBQUNrRyxTQUFTLENBQUM7TUFDMUIsSUFBSTZPLFNBQVMsQ0FBQzFPLElBQUksSUFBSSxRQUFRLEVBQUU7UUFDOUJyRyxRQUFRLENBQUNrRyxTQUFTLENBQUMsR0FBRzZPLFNBQVM7TUFDakM7SUFDRjtFQUNGLENBQUMsQ0FBQztFQUNGLE9BQU8vVSxRQUFRO0FBQ2pCLENBQUM7QUFBQyxJQUFBZ1YsUUFBQSxHQUFBQyxPQUFBLENBQUF2WCxPQUFBLEdBRWFpQixTQUFTO0FBQ3hCdVcsTUFBTSxDQUFDRCxPQUFPLEdBQUd0VyxTQUFTIiwiaWdub3JlTGlzdCI6W119