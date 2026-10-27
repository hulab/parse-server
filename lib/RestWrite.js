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
// Operations whose result the database computes from the stored value
const computedOperations = ['Increment', 'Add', 'AddUnique', 'Remove'];

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
  // The client's dot notation keys and computed operations, before triggers change the data
  this.requestOperations = Object.keys(this.data).filter(key => key.includes('.') || computedOperations.includes(this.data[key]?.__op)).map(key => [key, this.data[key]]);
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
    return this.checkInternalFields();
  }).then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.handleInstallation();
  }).then(() => {
    return this.handleSession();
  }).then(() => {
    return this.authorizeUserUpdate();
  }).then(() => {
    return this.validateAuthData();
  }).then(() => {
    return this.checkRestrictedFields();
  }).then(() => {
    return this.resolveFileUrls();
  }).then(() => {
    return this.validateDotNotationKeys();
  }).then(() => {
    return this.runBeforeSaveTrigger();
  }).then(() => {
    return this.ensureUniqueAuthDataId();
  }).then(() => {
    return this.deleteEmailResetTokenIfNeeded();
  }).then(() => {
    return this.validateWritePermission();
  }).then(() => {
    return this.validateSchema();
  }).then(schemaController => {
    this.validSchemaController = schemaController;
    return this.setRequiredFieldsIfNeeded();
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
    return this.filterUnreadableFieldsInResponse();
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

// Resolves the URLs of file pointers in the data that have no URL, so that the
// Parse objects built for triggers and LiveQuery can be encoded.
RestWrite.prototype.resolveFileUrls = async function () {
  const files = Object.create(null);
  const collect = value => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (value.__type === 'File') {
      if (typeof value.name !== 'string' || value.name === '') {
        throw new Parse.Error(Parse.Error.INCORRECT_TYPE, 'This is not a valid File');
      }
      if (!value.url) {
        files[value.name] = {
          __type: 'File',
          name: value.name
        };
      }
      return;
    }
    Object.values(value).forEach(collect);
  };
  collect(this.data);
  if (Object.keys(files).length === 0) {
    return;
  }
  await this.config.filesController.expandFilesInObject(this.config, files);
  this.fileUrls = Object.assign(this.fileUrls || Object.create(null), files);
};

// Returns a copy of the data with the resolved URLs added to file pointers.
RestWrite.prototype.cloneWithFileUrls = function (object) {
  const data = structuredClone(object);
  if (!this.fileUrls) {
    return data;
  }
  const addUrls = value => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (value.__type === 'File') {
      const file = typeof value.name === 'string' && this.fileUrls[value.name];
      if (!value.url && file) {
        value.url = file.url;
      }
      return;
    }
    Object.values(value).forEach(addUrls);
  };
  addUrls(data);
  return data;
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
    this.validateDotNotationKeys();
    if (response && response.object) {
      // The trigger may have set file pointers without URL
      return this.resolveFileUrls();
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
  const requiresCredentials = !this.query && !hasAuthData;
  const isMissing = value => typeof value !== 'string' || _lodash.default.isEmpty(value);
  // An empty username on create with authData is replaced by a random one
  const checkUsername = requiresCredentials || this.query && this.data.username !== undefined;
  const checkPassword = requiresCredentials || this.data.password !== undefined;
  if (checkUsername && isMissing(this.data.username)) {
    throw new Parse.Error(Parse.Error.USERNAME_MISSING, 'bad or missing username');
  }
  if (checkPassword && isMissing(this.data.password)) {
    throw new Parse.Error(Parse.Error.PASSWORD_MISSING, 'password is required');
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
  const isLogin = !userId;
  const userResult = results[0];
  const foundUserIsNotCurrentUser = userId && userResult && userId !== userResult.objectId;
  if (results.length > 1 || foundUserIsNotCurrentUser) {
    // To avoid https://github.com/parse-community/parse-server/security/advisories/GHSA-8w3j-g983-8jh5
    // Let's run some validation before throwing
    await Auth.handleAuthDataValidation(authData, this, userResult, {
      isLogin
    });
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }

  // No user found with provided authData we need to validate
  if (!results.length) {
    const {
      authData: validatedAuthData,
      authDataResponse
    } = await Auth.handleAuthDataValidation(authData, this, undefined, {
      isLogin
    });
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
      if (!isLogin && !hasMutatedAuthData && isCurrentUserLoggedOrMaster) {
        return;
      }

      // Always validate all provided authData on login to prevent authentication
      // bypass via partial authData (e.g. sending only the provider ID without
      // an access token); on update only validate mutated ones
      if (isLogin || hasMutatedAuthData || !this.config.allowExpiredAuthDataToken) {
        const res = await Auth.handleAuthDataValidation(isLogin ? authData : mutatedAuthData, this, userResult, {
          isLogin
        });
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

// Rejects internal fields in client-supplied data
RestWrite.prototype.checkInternalFields = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  for (const fieldName in this.data) {
    if (fieldName.charAt(0) === '_') {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}.`);
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

// Validates the create or update class-level permission before schema validation
RestWrite.prototype.validateWritePermission = async function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  const schemaController = await this.config.database.loadSchema();
  await schemaController.validatePermission(this.className, this.runOptions.acl || [], this.query ? 'update' : 'create');
};

// Authorize a _User update before any step reads the target account
RestWrite.prototype.authorizeUserUpdate = async function () {
  if (this.className !== '_User' || !this.query) {
    return;
  }
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  if (this.auth.isUnauthenticated()) {
    throw (0, _Error.createSanitizedError)(Parse.Error.SESSION_MISSING, `Cannot modify user ${this.query.objectId}.`, this.config);
  }
  // Body objectId must not retarget the update
  if (this.data.objectId !== undefined && this.data.objectId !== this.query.objectId) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
  }
  // Owner update reads only own data; the write stays ACL-checked
  if (this.auth.user.id === this.query.objectId) {
    return;
  }
  // Write access check via the write-path ACL enforcement
  await this.config.database.update(this.className, {
    objectId: this.query.objectId
  }, {}, this.runOptions, false, true);
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
  // Validate basic email address format in linear time
  if (!this.data.email.match(/^.[^@\n\r\u2028\u2029]*@.+$/)) {
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
    } else if (this.query) {
      // retrieve the User object using the URL object ID during password reset
      return this.config.database.find('_User', {
        objectId: this.query.objectId
      }).then(results => {
        if (results.length != 1) {
          throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
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
      objectId: this.query.objectId
    }, {
      keys: ['_password_history', '_hashed_password']
    }, Auth.maintenance(this.config)).then(results => {
      if (results.length != 1) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
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
    this.storage.issuedSessionToken = sessionData.sessionToken;
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
  // Skip if the response is already set, matching the other write-pipeline steps
  // (runDatabaseOperation, runAfterSaveTrigger). A non-master POST /classes/_Session
  // create has handleSession() set this.response before this runs, so this guard
  // prevents the dedup delete from acting on the client-supplied `user`/`installationId`
  // rather than on the server-generated session data.
  if (this.response) {
    return;
  }
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

    // Enforce the caller's class-level permissions and schema before the master write
    const validated = this.validateWritePermission().then(() => this.validateSchema());
    return validated.then(() => createSession()).then(results => {
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

  // The deduplication below embeds these client-supplied values directly into database
  // queries that delete or update rows with master privileges, and it runs before
  // `validateSchema`, so their types must be enforced here: a non-string value would
  // otherwise reach the database as a query constraint (such as an operator object
  // `{"$ne": null}`) matching rows the client never identified, instead of as a literal
  // value to match against. The schema declares all three as `String`, but that check
  // cannot be reused here; it runs later in the write pipeline and moving it earlier
  // would mutate the schema before the permission check. The field list is a property of
  // this function rather than of the schema: it is the set of values spliced into the
  // deduplication queries below.
  for (const fieldName of ['deviceToken', 'installationId', 'appIdentifier']) {
    const value = this.data[fieldName];
    if (value === undefined || value === null || typeof value === 'string') {
      continue;
    }
    if (fieldName === 'appIdentifier' && value.__op === 'Delete') {
      continue;
    }
    const actualType = Array.isArray(value) ? 'Array' : `${typeof value}`.replace(/^./, character => character.toUpperCase());
    throw new Parse.Error(Parse.Error.INCORRECT_TYPE, `schema mismatch for _Installation.${fieldName}; expected String but got ${actualType}`);
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

  // Create only: the request installation ID names the caller's own installation
  if (!installationId && !this.query && !this.auth.isMaster && !this.auth.isMaintenance) {
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
          // A `Delete` operation is applied only after the deduplication runs, and no
          // installation matched here to take a scope from. Skip the cleanup rather than
          // run it unscoped across every application, or query on the operation itself.
          if (typeof this.data.appIdentifier !== 'string') {
            return;
          }
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
            // A `Delete` operation is applied only after the deduplication runs, so scope
            // the cleanup to the value the matched installation still holds. Dropping the
            // constraint would let the cleanup reach installations of other applications,
            // and the operation itself cannot match a String, so skip the cleanup when no
            // scope is available.
            const appIdentifier = typeof this.data.appIdentifier === 'string' ? this.data.appIdentifier : idMatch.appIdentifier;
            if (typeof appIdentifier !== 'string') {
              return idMatch.objectId;
            }
            delQuery['appIdentifier'] = appIdentifier;
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
        objectId: this.query.objectId
      }, {
        keys: ['_password_history', '_hashed_password']
      }, Auth.maintenance(this.config)).then(results => {
        if (results.length != 1) {
          throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
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
      // The unsanitized result of a client update carries the read access of the object
      const raw = !this.runOptions.many && !this.auth.isMaster && !this.auth.isMaintenance;
      return this.config.database.update(this.className, this.query, this.data, this.runOptions, raw, false, this.validSchemaController).catch(error => {
        this._throwIfAuthDataDuplicate(error);
        throw error;
      }).then(async result => {
        let response = result;
        if (raw) {
          this.writtenReadAccess = result._rperm;
          this.writtenObject = result;
          response = await this.config.database._sanitizeDatabaseResult(this.data, result);
        }
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
      // Read access as stored
      const acl = this.data.ACL;
      this.writtenReadAccess = acl ? Object.keys(acl).filter(key => acl[key].read) : null;
      this.writtenObject = this.data;
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
  updatedObject._handleSaveResponse(this.cloneWithFileUrls(this.response.response), this.response.status || 200);
  if (hasLiveQuery) {
    this.config.database.loadSchema().then(schemaController => {
      // Notify LiveQueryServer if possible
      const perms = schemaController.getClassLevelPermissions(updatedObject.className);
      this.config.liveQueryController.onAfterSave(updatedObject.className, updatedObject, originalObject, perms);
    }).catch(err => {
      _logger.default.error('LiveQuery afterSave notification failed', err);
    });
  }
  if (!hasAfterSaveHook) {
    return Promise.resolve();
  }
  // Run afterSave trigger
  return triggers.maybeRunTrigger(triggers.Types.afterSave, this.auth, updatedObject, originalObject, this.config, this.context).then(result => {
    const jsonReturned = result && !result._toFullJSON;
    if (jsonReturned) {
      // The returned object is the response as is
      this.storage.responseFromTrigger = true;
      this.pendingOps.operations = {};
      this.response.response = result;
    } else {
      this.response.response = this._updateResponseWithData((result || updatedObject).toJSON(), this.data, true);
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
  }, this.cloneWithFileUrls(this.data));
  return Parse._decode(undefined, data);
};

// A raw view of the object's fields (stored values overlaid with whole-field
// writes in this request) used to resolve whether a dot notation key targets a
// pointer's object ID.
RestWrite.prototype._dotNotationFieldRoot = function () {
  const root = Object.assign({}, this.originalData);
  if (this.data) {
    for (const key of Object.keys(this.data)) {
      if (key.indexOf('.') < 0) {
        root[key] = this.data[key];
      }
    }
  }
  return root;
};
const prohibitedDotNotationKey = key => new Parse.Error(Parse.Error.INVALID_KEY_NAME, `Prohibited dot notation key in request data: ${JSON.stringify(key)}.`);

// Values the SDK decodes to an instance rather than a plain object: an operation or a
// typed value
const decodesToInstance = value => {
  if (typeof value.__op === 'string') {
    return true;
  }
  switch (value.__type) {
    case 'Pointer':
    case 'Object':
      return !!value.className;
    case 'Relation':
    case 'Date':
    case 'File':
    case 'GeoPoint':
    case 'Polygon':
      return true;
    default:
      return false;
  }
};

// Whether the SDK would resolve a non-leaf segment of the key, from the given depth
// on, through the prototype chain of the container instead of an own key, writing
// the final segment onto a shared built-in.
const descendsIntoPrototype = (container, segments, depth = 0) => {
  for (let i = depth; i < segments.length - 1; i++) {
    if (container === null || typeof container !== 'object') {
      return false;
    }
    // A further segment walks the prototype of the decoded instance
    if (decodesToInstance(container)) {
      return true;
    }
    const segment = segments[i];
    if (!hasOwn(container, segment)) {
      // An inherited member of a nested value resolves to a shared built-in; the root
      // has no prototype in the SDK, and a missing key is created fresh
      return i > 0 && segment in container;
    }
    container = container[segment];
  }
  return false;
};

// The container a written value provides for keys below it: the value itself, or
// the elements an array operation adds
const writtenContainer = value => {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  if (typeof value.__op === 'string') {
    return Array.isArray(value.objects) ? value.objects : undefined;
  }
  return value;
};

// Rejects a dot notation key that the SDK would apply through a prototype member of
// the stored object (the trigger object is built from it before the other fields of
// this request are applied), of the object as written by this request, or of a value
// another key of this request writes above it.
RestWrite.prototype.validateDotNotationKeys = function () {
  const keys = Object.keys(this.data);
  const keySet = new Set(keys);
  const roots = [this._dotNotationFieldRoot()];
  if (this.originalData) {
    roots.push(this.originalData);
  }
  // Only a key that is a prefix of this key, ending on a segment boundary, writes above it
  const writtenAbove = segments => {
    let prefix = segments[0];
    for (let depth = 1; depth < segments.length - 1; depth++) {
      if (keySet.has(prefix)) {
        const container = writtenContainer(this.data[prefix]);
        if (container !== undefined && descendsIntoPrototype(container, segments, depth)) {
          return true;
        }
      }
      prefix += `.${segments[depth]}`;
    }
    return false;
  };
  for (const key of keys) {
    if (key.indexOf('.') < 0) {
      continue;
    }
    const segments = key.split('.');
    if (roots.some(root => descendsIntoPrototype(root, segments)) || writtenAbove(segments)) {
      throw prohibitedDotNotationKey(key);
    }
  }
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
  const pointerRoot = this._dotNotationFieldRoot();
  Object.keys(this.data).reduce(function (data, key) {
    if (key.indexOf('.') > 0) {
      // Null and undefined are set at their own dot notation path, like an operation
      if (data[key] == null || typeof data[key].__op === 'string') {
        // A dot notation key that removes a pointer's object ID would leave the
        // pointer unserializable and break the trigger object, so skip it.
        if (!readOnlyAttributes.includes(key) && !targetsPointerId(pointerRoot, key)) {
          // The SDK key name rules apply to top-level fields only
          updatedObject.set(key, data[key], {
            ignoreValidation: true
          });
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
  }, this.cloneWithFileUrls(this.data));
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
  for (const key of Object.keys(this.response.response)) {
    if (protectedFields.some(field => key === field || key.startsWith(`${field}.`))) {
      delete this.response.response[key];
    }
  }
};
const hasOwn = (object, key) => object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);

// Whether a dot notation path can descend into the value
const isContainer = value => value !== null && typeof value === 'object' && !value.__type && !value.__op;

// Reads a dot notation path through own properties of containers only
const getOwnPath = (object, path) => {
  let value = object;
  for (const key of path) {
    if (!isContainer(value) || !hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
};

// Whether a dot notation key targets a pointer's object ID (`id`/`objectId`).
// Removing it leaves the pointer unserializable (`toPointer` throws), which
// corrupts the trigger object; other sub-keys below a pointer are left to the
// existing handling.
const targetsPointerId = (root, key) => {
  const segments = key.split('.');
  for (let depth = 1; depth < segments.length; depth++) {
    const parent = getOwnPath(root, segments.slice(0, depth));
    if (parent !== null && typeof parent === 'object' && parent.__type === 'Pointer') {
      const next = segments[depth];
      return next === 'id' || next === 'objectId';
    }
  }
  return false;
};

// Restores a reverted dot notation key in the response
RestWrite.prototype._restoreRevertedPath = function (response, writeData, written, key, finalObject) {
  // A write at or beneath the key governs
  if (written.some(k => k === key || k.startsWith(`${key}.`))) {
    return;
  }
  const path = key.split('.');
  // A returned object without the field leaves the stored value
  const fromFinal = !!finalObject && hasOwn(finalObject, path[0]);
  let value = fromFinal ? finalObject : this.originalData || {};
  let depth = 0;
  let authoritative = fromFinal;
  if (!fromFinal) {
    // A written ancestor governs; computed operations are returned expanded
    const ancestor = written.filter(k => key.startsWith(`${k}.`)).sort((a, b) => b.length - a.length)[0];
    if (ancestor) {
      const ancestorPath = ancestor.split('.');
      let returned = getOwnPath(response, ancestorPath);
      // An unchanged computed result is no longer in the response
      const op = writeData[ancestor]?.__op;
      if (returned === undefined && op && op !== 'Delete') {
        returned = getOwnPath(this.originalData, ancestorPath);
      }
      value = returned !== undefined ? returned : writeData[ancestor];
      if (!isContainer(value)) {
        return;
      }
      depth = ancestorPath.length;
      authoritative = true;
    }
  }
  while (depth < path.length && isContainer(value) && hasOwn(value, path[depth])) {
    value = value[path[depth++]];
  }
  // A missing array index returns the whole array, so the client keeps no hole
  const missingIndex = depth < path.length && Array.isArray(value) && /^\d+$/.test(path[depth]);
  if (depth < path.length && !missingIndex) {
    if (isContainer(value)) {
      // Delete at the first missing key
      depth++;
      value = undefined;
    } else if (value?.__op) {
      return;
    } else {
      const unchanged = util.isDeepStrictEqual(value, getOwnPath(this.originalData, path.slice(0, depth)));
      if (!fromFinal || unchanged) {
        // Clears the client operation beneath an unchanged typed value
        if (value?.__type && unchanged) {
          response[key] = {
            __op: 'Delete'
          };
        }
        return;
      }
    }
  }
  const target = path.slice(0, depth).join('.');
  const keys = [...written, ...Object.keys(response)];
  const overlaps = prefix => keys.some(k => k === prefix || k.startsWith(`${prefix}.`) || prefix.startsWith(`${k}.`));
  if (!authoritative && (value === undefined || missingIndex) && overlaps(target)) {
    // Another write creates the path; clear the shallowest untouched reverted part
    if (value === undefined) {
      for (let length = depth + 1; length <= path.length; length++) {
        const prefix = path.slice(0, length).join('.');
        if (!overlaps(prefix)) {
          response[prefix] = {
            __op: 'Delete'
          };
          break;
        }
      }
    }
    return;
  }
  for (const responseKey of Object.keys(response)) {
    if (responseKey.startsWith(`${target}.`)) {
      delete response[responseKey];
    }
  }
  response[target] = value === undefined ? {
    __op: 'Delete'
  } : value;
};

// The value of an operation applied to an empty value
const appliedToEmpty = value => {
  switch (value?.__op) {
    case 'Increment':
      return value.amount;
    case 'Add':
      return value.objects;
    case 'AddUnique':
      return _lodash.default.uniqWith(value.objects, util.isDeepStrictEqual);
    case 'Remove':
      return [];
    default:
      return value;
  }
};

// Sets the dot notation keys of the request in the response, applied to an empty value
RestWrite.prototype._setRequestPaths = function (response) {
  // Fields the response keeps, such as objectId
  const kept = Object.keys(response);
  const arrays = new Set();
  for (const [key, value] of this.requestOperations) {
    const segments = key.split('.');
    if (segments.length < 2 || kept.includes(segments[0])) {
      continue;
    }
    // The SDK cannot apply a dot notation path to ACL
    if (segments[0] === 'ACL') {
      continue;
    }
    const op = value?.__op;
    // Another operation, such as a relation operation, has no value
    if (op && op !== 'Delete' && !computedOperations.includes(op)) {
      continue;
    }
    // An index below an Array field
    if (this.validSchemaController.getExpectedType(this.className, segments[0])?.type === 'Array' && /^\d+$/.test(segments[1])) {
      arrays.add(segments[0]);
    }
    let container = response;
    for (const segment of segments.slice(0, -1)) {
      if (!hasOwn(container, segment) || !isContainer(container[segment])) {
        container[segment] = {};
      }
      container = container[segment];
    }
    // An unset leaves only the parents
    if (op !== 'Delete') {
      container[segments[segments.length - 1]] = appliedToEmpty(value);
    }
  }
  // Only the elements of the request, in index order
  for (const field of arrays) {
    response[field] = Object.values(response[field]);
  }
};

// Whether the caller can read the object as written; changes after the write are not considered
RestWrite.prototype._canReadWrittenObject = function (aclGroup) {
  const readers = this.writtenReadAccess;
  // A write result without valid read access fails closed
  if (readers !== null && !Array.isArray(readers)) {
    return false;
  }
  // The object ACL
  if (readers && !readers.some(reader => aclGroup.includes(reader))) {
    return false;
  }
  // A client reads a session with a find constrained to the session user
  const operation = this.className === '_Session' ? 'find' : 'get';
  const permissions = this.validSchemaController.getClassLevelPermissions(this.className);
  if (SchemaController.SchemaController.permissionDenial(permissions, this.className, aclGroup, operation)) {
    return false;
  }
  // The pointer permissions of the written object
  const users = aclGroup.filter(entry => entry !== '*' && !entry.startsWith('role:'));
  return SchemaController.SchemaController.testPointerPermissions(permissions, aclGroup, operation, users.length === 1 ? users[0] : undefined, field => {
    let value = this.writtenObject?.[field];
    // A create stores an operation applied to an empty value
    if (!this.query) {
      value = appliedToEmpty(value);
    }
    // An update result of the Postgres adapter has the objectId of a pointer
    const expected = this.validSchemaController.getExpectedType(this.className, field);
    return typeof value === 'string' && expected?.type === 'Pointer' ? {
      __type: 'Pointer',
      className: expected.targetClass,
      objectId: value
    } : value;
  });
};

// Returns stored values in a save response only if the caller can read the object as written
RestWrite.prototype.filterUnreadableFieldsInResponse = function () {
  const response = this.response?.response;
  if (!response || this.storage.responseFromTrigger) {
    return;
  }
  // Login and session requests build their own response
  if (!this.query && this.writtenReadAccess === undefined) {
    return;
  }
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  // A session token issued by this request is not a stored value
  const issued = this.storage.issuedSessionToken;
  // Nor is a required column that echoes the caller's unchanged input
  const echoed = key => (_SchemaController.requiredColumns.read[this.className] || []).includes(key) && !(this.storage.fieldsChangedByTrigger || []).includes(key) && !(key === 'username' && this.responseShouldHaveUsername) && util.isDeepStrictEqual(response[key], this.data[key]);
  const fields = Object.keys(response).filter(key => !['objectId', 'createdAt', 'updatedAt'].includes(key) && !(key === 'sessionToken' && issued && response[key] === issued) && !echoed(key));
  if (!fields.length) {
    return;
  }
  // A sign-up response is for the new user if it issues the new user a session
  const signUp = !this.query && this.className === '_User' && !!issued;
  const aclGroup = signUp ? ['*', this.data.objectId] : this.runOptions.acl || [];
  if (!this._canReadWrittenObject(aclGroup)) {
    // No stored values for a caller who cannot read the object
    for (const key of fields) {
      delete response[key];
    }
    this._setRequestPaths(response);
    return;
  }
  // A field reverted in beforeSave has the value of the original object, which triggers that are
  // exempt from protected fields read with the master key
  if (this.config.protectedFieldsTriggerExempt && this.query && this.pendingOps.operations) {
    const stateController = Parse.CoreManager.getObjectStateController();
    const [pending] = stateController.getPendingOps(this.pendingOps.identifier);
    const reverted = Object.keys(this.pendingOps.operations).filter(key => !pending[key]);
    for (const key of fields) {
      if (reverted.some(path => path === key || path.startsWith(`${key}.`) || key.startsWith(`${path}.`))) {
        delete response[key];
      }
    }
  }
};
RestWrite.prototype._updateResponseWithData = function (response, data, isFinalObject = false) {
  const stateController = Parse.CoreManager.getObjectStateController();
  const [pending] = stateController.getPendingOps(this.pendingOps.identifier);
  let revertedData;
  const revertedPaths = [];
  for (const key in this.pendingOps.operations) {
    if (pending[key]) {
      continue;
    }
    // The SDK cannot apply an operation or a dot notation path to ACL
    if (key.startsWith('ACL.') || key === 'ACL' && !hasOwn(this.originalData, 'ACL')) {
      continue;
    }
    if (key.includes('.')) {
      revertedPaths.push(key);
      continue;
    }
    // Response only; the write data builds the afterSave and LiveQuery objects
    revertedData ||= {
      ...data
    };
    revertedData[key] = hasOwn(this.originalData, key) ? this.originalData[key] : {
      __op: 'Delete'
    };
    this.storage.fieldsChangedByTrigger ||= [];
    // Once only, so an afterSave unset is not undone by a second entry
    if (this.storage.fieldsChangedByTrigger.indexOf(key) < 0) {
      this.storage.fieldsChangedByTrigger.push(key);
    }
  }
  const responseData = revertedData || data;
  // The final object, before unchanged fields are removed from the response
  const finalObject = isFinalObject && revertedPaths.length ? {
    ...response
  } : undefined;
  const skipKeys = [...(_SchemaController.requiredColumns.read[this.className] || [])];
  if (!this.query) {
    skipKeys.push('objectId', 'createdAt');
  } else {
    skipKeys.push('updatedAt');
    delete response.objectId;
  }
  // The client's operation results and dot notation parents, also if unchanged
  const requested = this.requestOperations.filter(([key]) => key.includes('.') ? hasOwn(data, key) : computedOperations.includes(data[key]?.__op)).map(([key]) => key.split('.')[0]);
  for (const key in response) {
    if (skipKeys.includes(key)) {
      continue;
    }
    const value = response[key];
    if (value == null || value.__type && value.__type === 'Pointer' || util.isDeepStrictEqual(responseData[key], value) || !requested.includes(key) && util.isDeepStrictEqual((this.originalData || {})[key], value)) {
      delete response[key];
    }
  }
  (this.storage.fieldsChangedByTrigger || []).forEach(fieldName => {
    const dataValue = responseData[fieldName];
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
  if (revertedPaths.length) {
    const written = Object.keys(data);
    for (const key of revertedPaths) {
      this._restoreRevertedPath(response, data, written, key, finalObject);
    }
  }
  return response;
};
var _default = exports.default = RestWrite;
module.exports = RestWrite;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUmVzdFF1ZXJ5IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9TY2hlbWFDb250cm9sbGVyIiwiX0Vycm9yIiwiX0F1dGhEYXRhTG9jayIsIkluc3RhbGxhdGlvbkRlZHVwIiwiX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQiLCJlIiwidCIsIldlYWtNYXAiLCJyIiwibiIsIl9fZXNNb2R1bGUiLCJvIiwiaSIsImYiLCJfX3Byb3RvX18iLCJkZWZhdWx0IiwiaGFzIiwiZ2V0Iiwic2V0IiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiT2JqZWN0IiwiZGVmaW5lUHJvcGVydHkiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IiLCJTY2hlbWFDb250cm9sbGVyIiwiQXV0aCIsIlV0aWxzIiwiY3J5cHRvVXRpbHMiLCJwYXNzd29yZENyeXB0byIsIlBhcnNlIiwidHJpZ2dlcnMiLCJ1dGlsIiwiY29tcHV0ZWRPcGVyYXRpb25zIiwiUmVzdFdyaXRlIiwiY29uZmlnIiwiYXV0aCIsImNsYXNzTmFtZSIsInF1ZXJ5IiwiZGF0YSIsIm9yaWdpbmFsRGF0YSIsImNvbnRleHQiLCJhY3Rpb24iLCJpc1JlYWRPbmx5IiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJFcnJvciIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJzdG9yYWdlIiwicnVuT3B0aW9ucyIsImFsbG93Q3VzdG9tT2JqZWN0SWQiLCJwcm90b3R5cGUiLCJvYmplY3RJZCIsIk1JU1NJTkdfT0JKRUNUX0lEIiwiSU5WQUxJRF9LRVlfTkFNRSIsImlkIiwicmVzcG9uc2UiLCJzdHJ1Y3R1cmVkQ2xvbmUiLCJyZXF1ZXN0T3BlcmF0aW9ucyIsImtleXMiLCJmaWx0ZXIiLCJrZXkiLCJpbmNsdWRlcyIsIl9fb3AiLCJtYXAiLCJ1cGRhdGVkQXQiLCJfZW5jb2RlIiwiRGF0ZSIsImlzbyIsInZhbGlkU2NoZW1hQ29udHJvbGxlciIsInBlbmRpbmdPcHMiLCJvcGVyYXRpb25zIiwiaWRlbnRpZmllciIsImV4ZWN1dGUiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJjaGVja0ludGVybmFsRmllbGRzIiwiZ2V0VXNlckFuZFJvbGVBQ0wiLCJ2YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24iLCJoYW5kbGVJbnN0YWxsYXRpb24iLCJoYW5kbGVTZXNzaW9uIiwiYXV0aG9yaXplVXNlclVwZGF0ZSIsInZhbGlkYXRlQXV0aERhdGEiLCJjaGVja1Jlc3RyaWN0ZWRGaWVsZHMiLCJyZXNvbHZlRmlsZVVybHMiLCJ2YWxpZGF0ZURvdE5vdGF0aW9uS2V5cyIsInJ1bkJlZm9yZVNhdmVUcmlnZ2VyIiwiZW5zdXJlVW5pcXVlQXV0aERhdGFJZCIsImRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkIiwidmFsaWRhdGVXcml0ZVBlcm1pc3Npb24iLCJ2YWxpZGF0ZVNjaGVtYSIsInNjaGVtYUNvbnRyb2xsZXIiLCJzZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkIiwidHJhbnNmb3JtVXNlciIsImV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzIiwiZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucyIsInJ1bkRhdGFiYXNlT3BlcmF0aW9uIiwiY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQiLCJoYW5kbGVGb2xsb3d1cCIsInJ1bkFmdGVyU2F2ZVRyaWdnZXIiLCJjbGVhblVzZXJBdXRoRGF0YSIsImZpbHRlclVucmVhZGFibGVGaWVsZHNJblJlc3BvbnNlIiwiZmlsdGVyUHJvdGVjdGVkRmllbGRzSW5SZXNwb25zZSIsImF1dGhEYXRhUmVzcG9uc2UiLCJyZWplY3RTaWdudXAiLCJwcmV2ZW50U2lnbnVwV2l0aFVudmVyaWZpZWRFbWFpbCIsIkVNQUlMX05PVF9GT1VORCIsImlzTWFzdGVyIiwiaXNNYWludGVuYW5jZSIsImFjbCIsInVzZXIiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsImNvbmNhdCIsImFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiIsInN5c3RlbUNsYXNzZXMiLCJpbmRleE9mIiwiZGF0YWJhc2UiLCJsb2FkU2NoZW1hIiwiaGFzQ2xhc3MiLCJ2YWxpZGF0ZU9iamVjdCIsImZpbGVzIiwiY3JlYXRlIiwiY29sbGVjdCIsInZhbHVlIiwiX190eXBlIiwibmFtZSIsIklOQ09SUkVDVF9UWVBFIiwidXJsIiwidmFsdWVzIiwiZm9yRWFjaCIsImxlbmd0aCIsImZpbGVzQ29udHJvbGxlciIsImV4cGFuZEZpbGVzSW5PYmplY3QiLCJmaWxlVXJscyIsImFzc2lnbiIsImNsb25lV2l0aEZpbGVVcmxzIiwib2JqZWN0IiwiYWRkVXJscyIsImZpbGUiLCJtYW55IiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYmVmb3JlU2F2ZSIsImFwcGxpY2F0aW9uSWQiLCJvcmlnaW5hbE9iamVjdCIsInVwZGF0ZWRPYmplY3QiLCJidWlsZFBhcnNlT2JqZWN0cyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJzdGF0ZUNvbnRyb2xsZXIiLCJDb3JlTWFuYWdlciIsImdldE9iamVjdFN0YXRlQ29udHJvbGxlciIsInBlbmRpbmciLCJnZXRQZW5kaW5nT3BzIiwiZGF0YWJhc2VQcm9taXNlIiwidXBkYXRlIiwicmVzdWx0IiwiT0JKRUNUX05PVF9GT1VORCIsIm1heWJlUnVuVHJpZ2dlciIsImZpZWxkc0NoYW5nZWRCeVRyaWdnZXIiLCJfIiwicmVkdWNlIiwiaXNFcXVhbCIsInB1c2giLCJjaGVja1Byb2hpYml0ZWRLZXl3b3JkcyIsImVycm9yIiwicnVuQmVmb3JlTG9naW5UcmlnZ2VyIiwidXNlckRhdGEiLCJiZWZvcmVMb2dpbiIsImV4dHJhRGF0YSIsImluZmxhdGUiLCJnZXRBbGxDbGFzc2VzIiwiYWxsQ2xhc3NlcyIsInNjaGVtYSIsImZpbmQiLCJvbmVDbGFzcyIsInNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCIsImZpZWxkTmFtZSIsInNldERlZmF1bHQiLCJ1bmRlZmluZWQiLCJmaWVsZHMiLCJkZWZhdWx0VmFsdWUiLCJyZXF1aXJlZCIsIlZBTElEQVRJT05fRVJST1IiLCJjbGFzc0xldmVsUGVybWlzc2lvbnMiLCJBQ0wiLCJKU09OIiwic3RyaW5naWZ5IiwicmVhZCIsIndyaXRlIiwiY3VycmVudFVzZXIiLCJjcmVhdGVkQXQiLCJuZXdPYmplY3RJZCIsIm9iamVjdElkU2l6ZSIsImF1dGhEYXRhIiwiaGFzVXNlcm5hbWVBbmRQYXNzd29yZCIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJoYXNBdXRoRGF0YSIsInNvbWUiLCJwcm92aWRlciIsInByb3ZpZGVyRGF0YSIsInJlcXVpcmVzQ3JlZGVudGlhbHMiLCJpc01pc3NpbmciLCJpc0VtcHR5IiwiY2hlY2tVc2VybmFtZSIsImNoZWNrUGFzc3dvcmQiLCJVU0VSTkFNRV9NSVNTSU5HIiwiUEFTU1dPUkRfTUlTU0lORyIsIlVOU1VQUE9SVEVEX1NFUlZJQ0UiLCJwcm92aWRlcnMiLCJjYW5IYW5kbGVBdXRoRGF0YSIsInByb3ZpZGVyQXV0aERhdGEiLCJnZXRVc2VySWQiLCJoYW5kbGVBdXRoRGF0YSIsImZpbHRlcmVkT2JqZWN0c0J5QUNMIiwib2JqZWN0cyIsIl90aHJvd0lmQXV0aERhdGFEdXBsaWNhdGUiLCJjb2RlIiwiRFVQTElDQVRFX1ZBTFVFIiwidXNlckluZm8iLCJkdXBsaWNhdGVkX2ZpZWxkIiwic3RhcnRzV2l0aCIsIkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQiLCJoYXNBdXRoRGF0YUlkIiwiZmluZFVzZXJzV2l0aEF1dGhEYXRhIiwicmVzdWx0cyIsInVzZXJJZCIsImN1cnJlbnRVc2VyQXV0aERhdGEiLCJpc0xvZ2luIiwidXNlclJlc3VsdCIsImZvdW5kVXNlcklzTm90Q3VycmVudFVzZXIiLCJoYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24iLCJ2YWxpZGF0ZWRBdXRoRGF0YSIsImF1dGhQcm92aWRlciIsImpvaW4iLCJoYXNNdXRhdGVkQXV0aERhdGEiLCJtdXRhdGVkQXV0aERhdGEiLCJpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIiLCJsb2NhdGlvbiIsImNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4iLCJhbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuIiwicmVzIiwib3JpZ2luYWxBdXRoRGF0YSIsImZyb21FbnRyaWVzIiwiZW50cmllcyIsImsiLCJ2IiwiYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrIiwiU0NSSVBUX0ZBSUxFRCIsImNoYXJBdCIsInZhbGlkYXRlUGVybWlzc2lvbiIsImlzVW5hdXRoZW50aWNhdGVkIiwiU0VTU0lPTl9NSVNTSU5HIiwicHJvbWlzZSIsIlJlc3RRdWVyeSIsIm1ldGhvZCIsIk1ldGhvZCIsIm1hc3RlciIsInJ1bkJlZm9yZUZpbmQiLCJyZXN0V2hlcmUiLCJzZXNzaW9uIiwiY2FjaGVDb250cm9sbGVyIiwiZGVsIiwic2Vzc2lvblRva2VuIiwiX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kiLCJoYXNoIiwiaGFzaGVkUGFzc3dvcmQiLCJfaGFzaGVkX3Bhc3N3b3JkIiwiX3ZhbGlkYXRlVXNlck5hbWUiLCJfdmFsaWRhdGVFbWFpbCIsInJhbmRvbVN0cmluZyIsInJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lIiwiJG5lIiwibGltaXQiLCJjYXNlSW5zZW5zaXRpdmUiLCJVU0VSTkFNRV9UQUtFTiIsImJ1aWxkQ3JlYXRlZFdpdGgiLCJnZXRDcmVhdGVkV2l0aCIsImNyZWF0ZWRXaXRoIiwiaXNDcmVhdGVPcGVyYXRpb24iLCJhdXRoRGF0YVByb3ZpZGVyIiwicmVzb2x2ZWRBdXRoUHJvdmlkZXIiLCJlbWFpbCIsIm1hdGNoIiwicmVqZWN0IiwiSU5WQUxJRF9FTUFJTF9BRERSRVNTIiwiRU1BSUxfVEFLRU4iLCJyZXF1ZXN0Iiwib3JpZ2luYWwiLCJpcCIsImluc3RhbGxhdGlvbklkIiwidXNlckNvbnRyb2xsZXIiLCJzZXRFbWFpbFZlcmlmeVRva2VuIiwicGFzc3dvcmRQb2xpY3kiLCJfdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cyIsIl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSIsInBvbGljeUVycm9yIiwidmFsaWRhdGlvbkVycm9yIiwiY29udGFpbnNVc2VybmFtZUVycm9yIiwicGF0dGVyblZhbGlkYXRvciIsInZhbGlkYXRvckNhbGxiYWNrIiwiZG9Ob3RBbGxvd1VzZXJuYW1lIiwibWF4UGFzc3dvcmRIaXN0b3J5IiwibWFpbnRlbmFuY2UiLCJvbGRQYXNzd29yZHMiLCJfcGFzc3dvcmRfaGlzdG9yeSIsInRha2UiLCJuZXdQYXNzd29yZCIsInByb21pc2VzIiwiY29tcGFyZSIsImFsbCIsImNhdGNoIiwiZXJyIiwidmVyaWZ5VXNlckVtYWlscyIsInByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwiLCJjcmVhdGVTZXNzaW9uVG9rZW4iLCJzZXNzaW9uRGF0YSIsImNyZWF0ZVNlc3Npb24iLCJpc3N1ZWRTZXNzaW9uVG9rZW4iLCJhZGRpdGlvbmFsU2Vzc2lvbkRhdGEiLCJ0b2tlbiIsIm5ld1Rva2VuIiwiZXhwaXJlc0F0IiwiZ2VuZXJhdGVTZXNzaW9uRXhwaXJlc0F0IiwiYWRkT3BzIiwiX3BlcmlzaGFibGVfdG9rZW4iLCJfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0IiwiZGVzdHJveSIsInJldm9rZVNlc3Npb25PblBhc3N3b3JkUmVzZXQiLCJzZXNzaW9uUXVlcnkiLCJiaW5kIiwic2VuZFZlcmlmaWNhdGlvbkVtYWlsIiwiSU5WQUxJRF9TRVNTSU9OX1RPS0VOIiwiJGFuZCIsInZhbGlkYXRlZCIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsInN0YXR1cyIsImFjdHVhbFR5cGUiLCJBcnJheSIsImlzQXJyYXkiLCJyZXBsYWNlIiwiY2hhcmFjdGVyIiwidG9VcHBlckNhc2UiLCJkZXZpY2VUb2tlbiIsInRvTG93ZXJDYXNlIiwiZGV2aWNlVHlwZSIsImlkTWF0Y2giLCJvYmplY3RJZE1hdGNoIiwiaW5zdGFsbGF0aW9uSWRNYXRjaCIsImRldmljZVRva2VuTWF0Y2hlcyIsIm9yUXVlcmllcyIsIiRvciIsImRlbFF1ZXJ5IiwiYXBwSWRlbnRpZmllciIsImluc3RhbGxhdGlvbk9wdHMiLCJpbnN0YWxsYXRpb24iLCJyZW1vdmVDb25mbGljdGluZ0RldmljZVRva2VuIiwiZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24iLCJlbmZvcmNlQXV0aCIsImR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGgiLCJhcHBseUR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2UiLCJkZXZpY2VUb2tlbk1hdGNoIiwibWVyZ2VQcmlvcml0eSIsImR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2VQcmlvcml0eSIsIm9iaklkIiwidXNlcnMiLCJyb2xlIiwibGl2ZVF1ZXJ5Q29udHJvbGxlciIsImNsZWFyQ2FjaGVkUm9sZXMiLCJVc2VyIiwiY3JlYXRlV2l0aG91dERhdGEiLCJjbGVhciIsImRvd25sb2FkIiwiZG93bmxvYWROYW1lIiwiSU5WQUxJRF9BQ0wiLCJtYXhQYXNzd29yZEFnZSIsIl9wYXNzd29yZF9jaGFuZ2VkX2F0IiwiZGVmZXIiLCJNYXRoIiwibWF4Iiwic2hpZnQiLCJyYXciLCJ3cml0dGVuUmVhZEFjY2VzcyIsIl9ycGVybSIsIndyaXR0ZW5PYmplY3QiLCJfc2FuaXRpemVEYXRhYmFzZVJlc3VsdCIsIl91cGRhdGVSZXNwb25zZVdpdGhEYXRhIiwiZW5mb3JjZVByaXZhdGVVc2VycyIsImhhc0FmdGVyU2F2ZUhvb2siLCJhZnRlclNhdmUiLCJoYXNMaXZlUXVlcnkiLCJfaGFuZGxlU2F2ZVJlc3BvbnNlIiwicGVybXMiLCJnZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJvbkFmdGVyU2F2ZSIsImxvZ2dlciIsImpzb25SZXR1cm5lZCIsIl90b0Z1bGxKU09OIiwicmVzcG9uc2VGcm9tVHJpZ2dlciIsInRvSlNPTiIsIndhcm4iLCJtaWRkbGUiLCJtb3VudCIsInNlcnZlclVSTCIsInNhbml0aXplZERhdGEiLCJ0ZXN0IiwiX2RlY29kZSIsIl9kb3ROb3RhdGlvbkZpZWxkUm9vdCIsInJvb3QiLCJwcm9oaWJpdGVkRG90Tm90YXRpb25LZXkiLCJkZWNvZGVzVG9JbnN0YW5jZSIsImRlc2NlbmRzSW50b1Byb3RvdHlwZSIsImNvbnRhaW5lciIsInNlZ21lbnRzIiwiZGVwdGgiLCJzZWdtZW50IiwiaGFzT3duIiwid3JpdHRlbkNvbnRhaW5lciIsImtleVNldCIsIlNldCIsInJvb3RzIiwid3JpdHRlbkFib3ZlIiwicHJlZml4Iiwic3BsaXQiLCJmcm9tSlNPTiIsInJlYWRPbmx5QXR0cmlidXRlcyIsImNvbnN0cnVjdG9yIiwiaXNSb2xlQWZ0ZXJTYXZlIiwiYXR0cmlidXRlIiwicG9pbnRlclJvb3QiLCJ0YXJnZXRzUG9pbnRlcklkIiwiaWdub3JlVmFsaWRhdGlvbiIsInNwbGl0dGVkS2V5IiwicGFyZW50UHJvcCIsInBhcmVudFZhbCIsInNhbml0aXplZCIsInByb3RlY3RlZEZpZWxkc1NhdmVSZXNwb25zZUV4ZW1wdCIsInByb3RlY3RlZEZpZWxkcyIsImFkZFByb3RlY3RlZEZpZWxkcyIsInVzZXJSb2xlcyIsImZpZWxkIiwiaXNDb250YWluZXIiLCJnZXRPd25QYXRoIiwicGF0aCIsInBhcmVudCIsInNsaWNlIiwibmV4dCIsIl9yZXN0b3JlUmV2ZXJ0ZWRQYXRoIiwid3JpdGVEYXRhIiwid3JpdHRlbiIsImZpbmFsT2JqZWN0IiwiZnJvbUZpbmFsIiwiYXV0aG9yaXRhdGl2ZSIsImFuY2VzdG9yIiwic29ydCIsImEiLCJiIiwiYW5jZXN0b3JQYXRoIiwicmV0dXJuZWQiLCJvcCIsIm1pc3NpbmdJbmRleCIsInVuY2hhbmdlZCIsImlzRGVlcFN0cmljdEVxdWFsIiwidGFyZ2V0Iiwib3ZlcmxhcHMiLCJyZXNwb25zZUtleSIsImFwcGxpZWRUb0VtcHR5IiwiYW1vdW50IiwidW5pcVdpdGgiLCJfc2V0UmVxdWVzdFBhdGhzIiwia2VwdCIsImFycmF5cyIsImdldEV4cGVjdGVkVHlwZSIsInR5cGUiLCJhZGQiLCJfY2FuUmVhZFdyaXR0ZW5PYmplY3QiLCJhY2xHcm91cCIsInJlYWRlcnMiLCJyZWFkZXIiLCJvcGVyYXRpb24iLCJwZXJtaXNzaW9ucyIsInBlcm1pc3Npb25EZW5pYWwiLCJlbnRyeSIsInRlc3RQb2ludGVyUGVybWlzc2lvbnMiLCJleHBlY3RlZCIsInRhcmdldENsYXNzIiwiaXNzdWVkIiwiZWNob2VkIiwicmVxdWlyZWRDb2x1bW5zIiwic2lnblVwIiwicHJvdGVjdGVkRmllbGRzVHJpZ2dlckV4ZW1wdCIsInJldmVydGVkIiwiaXNGaW5hbE9iamVjdCIsInJldmVydGVkRGF0YSIsInJldmVydGVkUGF0aHMiLCJyZXNwb25zZURhdGEiLCJza2lwS2V5cyIsInJlcXVlc3RlZCIsImRhdGFWYWx1ZSIsIl9kZWZhdWx0IiwiZXhwb3J0cyIsIm1vZHVsZSJdLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0V3JpdGUuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQSBSZXN0V3JpdGUgZW5jYXBzdWxhdGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCB0byBydW4gYW4gb3BlcmF0aW9uXG4vLyB0aGF0IHdyaXRlcyB0byB0aGUgZGF0YWJhc2UuXG4vLyBUaGlzIGNvdWxkIGJlIGVpdGhlciBhIFwiY3JlYXRlXCIgb3IgYW4gXCJ1cGRhdGVcIi5cblxudmFyIFNjaGVtYUNvbnRyb2xsZXIgPSByZXF1aXJlKCcuL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXInKTtcblxuY29uc3QgQXV0aCA9IHJlcXVpcmUoJy4vQXV0aCcpO1xuY29uc3QgVXRpbHMgPSByZXF1aXJlKCcuL1V0aWxzJyk7XG52YXIgY3J5cHRvVXRpbHMgPSByZXF1aXJlKCcuL2NyeXB0b1V0aWxzJyk7XG52YXIgcGFzc3dvcmRDcnlwdG8gPSByZXF1aXJlKCcuL3Bhc3N3b3JkJyk7XG52YXIgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJyk7XG52YXIgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuaW1wb3J0IFJlc3RRdWVyeSBmcm9tICcuL1Jlc3RRdWVyeSc7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IGxvZ2dlciBmcm9tICcuL2xvZ2dlcic7XG5pbXBvcnQgeyByZXF1aXJlZENvbHVtbnMgfSBmcm9tICcuL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXInO1xuaW1wb3J0IHsgY3JlYXRlU2FuaXRpemVkRXJyb3IgfSBmcm9tICcuL0Vycm9yJztcbmltcG9ydCB7IGFwcGx5QXV0aERhdGFPcHRpbWlzdGljTG9jayB9IGZyb20gJy4vQXV0aERhdGFMb2NrJztcbmltcG9ydCAqIGFzIEluc3RhbGxhdGlvbkRlZHVwIGZyb20gJy4vSW5zdGFsbGF0aW9uRGVkdXAnO1xuXG4vLyBPcGVyYXRpb25zIHdob3NlIHJlc3VsdCB0aGUgZGF0YWJhc2UgY29tcHV0ZXMgZnJvbSB0aGUgc3RvcmVkIHZhbHVlXG5jb25zdCBjb21wdXRlZE9wZXJhdGlvbnMgPSBbJ0luY3JlbWVudCcsICdBZGQnLCAnQWRkVW5pcXVlJywgJ1JlbW92ZSddO1xuXG4vLyBxdWVyeSBhbmQgZGF0YSBhcmUgYm90aCBwcm92aWRlZCBpbiBSRVNUIEFQSSBmb3JtYXQuIFNvIGRhdGFcbi8vIHR5cGVzIGFyZSBlbmNvZGVkIGJ5IHBsYWluIG9sZCBvYmplY3RzLlxuLy8gSWYgcXVlcnkgaXMgbnVsbCwgdGhpcyBpcyBhIFwiY3JlYXRlXCIgYW5kIHRoZSBkYXRhIGluIGRhdGEgc2hvdWxkIGJlXG4vLyBjcmVhdGVkLlxuLy8gT3RoZXJ3aXNlIHRoaXMgaXMgYW4gXCJ1cGRhdGVcIiAtIHRoZSBvYmplY3QgbWF0Y2hpbmcgdGhlIHF1ZXJ5XG4vLyBzaG91bGQgZ2V0IHVwZGF0ZWQgd2l0aCBkYXRhLlxuLy8gUmVzdFdyaXRlIHdpbGwgaGFuZGxlIG9iamVjdElkLCBjcmVhdGVkQXQsIGFuZCB1cGRhdGVkQXQgZm9yXG4vLyBldmVyeXRoaW5nLiBJdCBhbHNvIGtub3dzIHRvIHVzZSB0cmlnZ2VycyBhbmQgc3BlY2lhbCBtb2RpZmljYXRpb25zXG4vLyBmb3IgdGhlIF9Vc2VyIGNsYXNzLlxuZnVuY3Rpb24gUmVzdFdyaXRlKGNvbmZpZywgYXV0aCwgY2xhc3NOYW1lLCBxdWVyeSwgZGF0YSwgb3JpZ2luYWxEYXRhLCBjb250ZXh0LCBhY3Rpb24pIHtcbiAgaWYgKGF1dGguaXNSZWFkT25seSkge1xuICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICdDYW5ub3QgcGVyZm9ybSBhIHdyaXRlIG9wZXJhdGlvbiB3aGVuIHVzaW5nIHJlYWRPbmx5TWFzdGVyS2V5JyxcbiAgICAgIGNvbmZpZ1xuICAgICk7XG4gIH1cbiAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gIHRoaXMuYXV0aCA9IGF1dGg7XG4gIHRoaXMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB0aGlzLnN0b3JhZ2UgPSB7fTtcbiAgdGhpcy5ydW5PcHRpb25zID0ge307XG4gIHRoaXMuY29udGV4dCA9IGNvbnRleHQgfHwge307XG5cbiAgaWYgKGFjdGlvbikge1xuICAgIHRoaXMucnVuT3B0aW9ucy5hY3Rpb24gPSBhY3Rpb247XG4gIH1cblxuICBpZiAoIXF1ZXJ5KSB7XG4gICAgaWYgKHRoaXMuY29uZmlnLmFsbG93Q3VzdG9tT2JqZWN0SWQpIHtcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoZGF0YSwgJ29iamVjdElkJykgJiYgIWRhdGEub2JqZWN0SWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLk1JU1NJTkdfT0JKRUNUX0lELFxuICAgICAgICAgICdvYmplY3RJZCBtdXN0IG5vdCBiZSBlbXB0eSwgbnVsbCBvciB1bmRlZmluZWQnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChkYXRhLm9iamVjdElkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnb2JqZWN0SWQgaXMgYW4gaW52YWxpZCBmaWVsZCBuYW1lLicpO1xuICAgICAgfVxuICAgICAgaWYgKGRhdGEuaWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdpZCBpcyBhbiBpbnZhbGlkIGZpZWxkIG5hbWUuJyk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gV2hlbiB0aGUgb3BlcmF0aW9uIGlzIGNvbXBsZXRlLCB0aGlzLnJlc3BvbnNlIG1heSBoYXZlIHNldmVyYWxcbiAgLy8gZmllbGRzLlxuICAvLyByZXNwb25zZTogdGhlIGFjdHVhbCBkYXRhIHRvIGJlIHJldHVybmVkXG4gIC8vIHN0YXR1czogdGhlIGh0dHAgc3RhdHVzIGNvZGUuIGlmIG5vdCBwcmVzZW50LCB0cmVhdGVkIGxpa2UgYSAyMDBcbiAgLy8gbG9jYXRpb246IHRoZSBsb2NhdGlvbiBoZWFkZXIuIGlmIG5vdCBwcmVzZW50LCBubyBsb2NhdGlvbiBoZWFkZXJcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG5cbiAgLy8gUHJvY2Vzc2luZyB0aGlzIG9wZXJhdGlvbiBtYXkgbXV0YXRlIG91ciBkYXRhLCBzbyB3ZSBvcGVyYXRlIG9uIGFcbiAgLy8gY29weVxuICB0aGlzLnF1ZXJ5ID0gc3RydWN0dXJlZENsb25lKHF1ZXJ5KTtcbiAgdGhpcy5kYXRhID0gc3RydWN0dXJlZENsb25lKGRhdGEpO1xuICAvLyBUaGUgY2xpZW50J3MgZG90IG5vdGF0aW9uIGtleXMgYW5kIGNvbXB1dGVkIG9wZXJhdGlvbnMsIGJlZm9yZSB0cmlnZ2VycyBjaGFuZ2UgdGhlIGRhdGFcbiAgdGhpcy5yZXF1ZXN0T3BlcmF0aW9ucyA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YSlcbiAgICAuZmlsdGVyKGtleSA9PiBrZXkuaW5jbHVkZXMoJy4nKSB8fCBjb21wdXRlZE9wZXJhdGlvbnMuaW5jbHVkZXModGhpcy5kYXRhW2tleV0/Ll9fb3ApKVxuICAgIC5tYXAoa2V5ID0+IFtrZXksIHRoaXMuZGF0YVtrZXldXSk7XG4gIC8vIFdlIG5ldmVyIGNoYW5nZSBvcmlnaW5hbERhdGEsIHNvIHdlIGRvIG5vdCBuZWVkIGEgZGVlcCBjb3B5XG4gIHRoaXMub3JpZ2luYWxEYXRhID0gb3JpZ2luYWxEYXRhO1xuXG4gIC8vIFRoZSB0aW1lc3RhbXAgd2UnbGwgdXNlIGZvciB0aGlzIHdob2xlIG9wZXJhdGlvblxuICB0aGlzLnVwZGF0ZWRBdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSkuaXNvO1xuXG4gIC8vIFNoYXJlZCBTY2hlbWFDb250cm9sbGVyIHRvIGJlIHJldXNlZCB0byByZWR1Y2UgdGhlIG51bWJlciBvZiBsb2FkU2NoZW1hKCkgY2FsbHMgcGVyIHJlcXVlc3RcbiAgLy8gT25jZSBzZXQgdGhlIHNjaGVtYURhdGEgc2hvdWxkIGJlIGltbXV0YWJsZVxuICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlciA9IG51bGw7XG4gIHRoaXMucGVuZGluZ09wcyA9IHtcbiAgICBvcGVyYXRpb25zOiBudWxsLFxuICAgIGlkZW50aWZpZXI6IG51bGwsXG4gIH07XG59XG5cbi8vIEEgY29udmVuaWVudCBtZXRob2QgdG8gcGVyZm9ybSBhbGwgdGhlIHN0ZXBzIG9mIHByb2Nlc3NpbmcgdGhlXG4vLyB3cml0ZSwgaW4gb3JkZXIuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSB7cmVzcG9uc2UsIHN0YXR1cywgbG9jYXRpb259IG9iamVjdC5cbi8vIHN0YXR1cyBhbmQgbG9jYXRpb24gYXJlIG9wdGlvbmFsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jaGVja0ludGVybmFsRmllbGRzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5nZXRVc2VyQW5kUm9sZUFDTCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVJbnN0YWxsYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZVNlc3Npb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmF1dGhvcml6ZVVzZXJVcGRhdGUoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQXV0aERhdGEoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNoZWNrUmVzdHJpY3RlZEZpZWxkcygpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVzb2x2ZUZpbGVVcmxzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZURvdE5vdGF0aW9uS2V5cygpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuQmVmb3JlU2F2ZVRyaWdnZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmVuc3VyZVVuaXF1ZUF1dGhEYXRhSWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZVdyaXRlUGVybWlzc2lvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVTY2hlbWEoKTtcbiAgICB9KVxuICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIgPSBzY2hlbWFDb250cm9sbGVyO1xuICAgICAgcmV0dXJuIHRoaXMuc2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudHJhbnNmb3JtVXNlcigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkRhdGFiYXNlT3BlcmF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlRm9sbG93dXAoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkFmdGVyU2F2ZVRyaWdnZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNsZWFuVXNlckF1dGhEYXRhKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5maWx0ZXJVbnJlYWRhYmxlRmllbGRzSW5SZXNwb25zZSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZmlsdGVyUHJvdGVjdGVkRmllbGRzSW5SZXNwb25zZSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gQXBwZW5kIHRoZSBhdXRoRGF0YVJlc3BvbnNlIGlmIGV4aXN0c1xuICAgICAgaWYgKHRoaXMuYXV0aERhdGFSZXNwb25zZSkge1xuICAgICAgICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5hdXRoRGF0YVJlc3BvbnNlID0gdGhpcy5hdXRoRGF0YVJlc3BvbnNlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5zdG9yYWdlLnJlamVjdFNpZ251cCAmJiB0aGlzLmNvbmZpZy5wcmV2ZW50U2lnbnVwV2l0aFVudmVyaWZpZWRFbWFpbCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRU1BSUxfTk9UX0ZPVU5ELCAnVXNlciBlbWFpbCBpcyBub3QgdmVyaWZpZWQuJyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5yZXNwb25zZTtcbiAgICB9KTtcbn07XG5cbi8vIFVzZXMgdGhlIEF1dGggb2JqZWN0IHRvIGdldCB0aGUgbGlzdCBvZiByb2xlcywgYWRkcyB0aGUgdXNlciBpZFxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VyQW5kUm9sZUFDTCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMucnVuT3B0aW9ucy5hY2wgPSBbJyonXTtcblxuICBpZiAodGhpcy5hdXRoLnVzZXIpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLmdldFVzZXJSb2xlcygpLnRoZW4ocm9sZXMgPT4ge1xuICAgICAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IHRoaXMucnVuT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbdGhpcy5hdXRoLnVzZXIuaWRdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmIChcbiAgICB0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmXG4gICAgIXRoaXMuYXV0aC5pc01hc3RlciAmJlxuICAgICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJlxuICAgIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTFcbiAgKSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICAnVGhpcyB1c2VyIGlzIG5vdCBhbGxvd2VkIHRvIGFjY2VzcyBub24tZXhpc3RlbnQgY2xhc3M6ICcgKyB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHRoaXMuY29uZmlnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgc2NoZW1hLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZVNjaGVtYSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnZhbGlkYXRlT2JqZWN0KFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRoaXMuZGF0YSxcbiAgICB0aGlzLnF1ZXJ5LFxuICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICB0aGlzLmF1dGguaXNNYWludGVuYW5jZVxuICApO1xufTtcblxuLy8gUmVzb2x2ZXMgdGhlIFVSTHMgb2YgZmlsZSBwb2ludGVycyBpbiB0aGUgZGF0YSB0aGF0IGhhdmUgbm8gVVJMLCBzbyB0aGF0IHRoZVxuLy8gUGFyc2Ugb2JqZWN0cyBidWlsdCBmb3IgdHJpZ2dlcnMgYW5kIExpdmVRdWVyeSBjYW4gYmUgZW5jb2RlZC5cblJlc3RXcml0ZS5wcm90b3R5cGUucmVzb2x2ZUZpbGVVcmxzID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBjb25zdCBmaWxlcyA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG4gIGNvbnN0IGNvbGxlY3QgPSB2YWx1ZSA9PiB7XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh2YWx1ZS5fX3R5cGUgPT09ICdGaWxlJykge1xuICAgICAgaWYgKHR5cGVvZiB2YWx1ZS5uYW1lICE9PSAnc3RyaW5nJyB8fCB2YWx1ZS5uYW1lID09PSAnJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5DT1JSRUNUX1RZUEUsICdUaGlzIGlzIG5vdCBhIHZhbGlkIEZpbGUnKTtcbiAgICAgIH1cbiAgICAgIGlmICghdmFsdWUudXJsKSB7XG4gICAgICAgIGZpbGVzW3ZhbHVlLm5hbWVdID0geyBfX3R5cGU6ICdGaWxlJywgbmFtZTogdmFsdWUubmFtZSB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBPYmplY3QudmFsdWVzKHZhbHVlKS5mb3JFYWNoKGNvbGxlY3QpO1xuICB9O1xuICBjb2xsZWN0KHRoaXMuZGF0YSk7XG4gIGlmIChPYmplY3Qua2V5cyhmaWxlcykubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHRoaXMuY29uZmlnLCBmaWxlcyk7XG4gIHRoaXMuZmlsZVVybHMgPSBPYmplY3QuYXNzaWduKHRoaXMuZmlsZVVybHMgfHwgT2JqZWN0LmNyZWF0ZShudWxsKSwgZmlsZXMpO1xufTtcblxuLy8gUmV0dXJucyBhIGNvcHkgb2YgdGhlIGRhdGEgd2l0aCB0aGUgcmVzb2x2ZWQgVVJMcyBhZGRlZCB0byBmaWxlIHBvaW50ZXJzLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5jbG9uZVdpdGhGaWxlVXJscyA9IGZ1bmN0aW9uIChvYmplY3QpIHtcbiAgY29uc3QgZGF0YSA9IHN0cnVjdHVyZWRDbG9uZShvYmplY3QpO1xuICBpZiAoIXRoaXMuZmlsZVVybHMpIHtcbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuICBjb25zdCBhZGRVcmxzID0gdmFsdWUgPT4ge1xuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0Jykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodmFsdWUuX190eXBlID09PSAnRmlsZScpIHtcbiAgICAgIGNvbnN0IGZpbGUgPSB0eXBlb2YgdmFsdWUubmFtZSA9PT0gJ3N0cmluZycgJiYgdGhpcy5maWxlVXJsc1t2YWx1ZS5uYW1lXTtcbiAgICAgIGlmICghdmFsdWUudXJsICYmIGZpbGUpIHtcbiAgICAgICAgdmFsdWUudXJsID0gZmlsZS51cmw7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIE9iamVjdC52YWx1ZXModmFsdWUpLmZvckVhY2goYWRkVXJscyk7XG4gIH07XG4gIGFkZFVybHMoZGF0YSk7XG4gIHJldHVybiBkYXRhO1xufTtcblxuLy8gUnVucyBhbnkgYmVmb3JlU2F2ZSB0cmlnZ2VycyBhZ2FpbnN0IHRoaXMgb3BlcmF0aW9uLlxuLy8gQW55IGNoYW5nZSBsZWFkcyB0byBvdXIgZGF0YSBiZWluZyBtdXRhdGVkLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5CZWZvcmVTYXZlVHJpZ2dlciA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5ydW5PcHRpb25zLm1hbnkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdiZWZvcmVTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBpZiAoXG4gICAgIXRyaWdnZXJzLnRyaWdnZXJFeGlzdHModGhpcy5jbGFzc05hbWUsIHRyaWdnZXJzLlR5cGVzLmJlZm9yZVNhdmUsIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWQpXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGNvbnN0IHsgb3JpZ2luYWxPYmplY3QsIHVwZGF0ZWRPYmplY3QgfSA9IHRoaXMuYnVpbGRQYXJzZU9iamVjdHMoKTtcbiAgY29uc3QgaWRlbnRpZmllciA9IHVwZGF0ZWRPYmplY3QuX2dldFN0YXRlSWRlbnRpZmllcigpO1xuICBjb25zdCBzdGF0ZUNvbnRyb2xsZXIgPSBQYXJzZS5Db3JlTWFuYWdlci5nZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIoKTtcbiAgY29uc3QgW3BlbmRpbmddID0gc3RhdGVDb250cm9sbGVyLmdldFBlbmRpbmdPcHMoaWRlbnRpZmllcik7XG4gIHRoaXMucGVuZGluZ09wcyA9IHtcbiAgICBvcGVyYXRpb25zOiB7IC4uLnBlbmRpbmcgfSxcbiAgICBpZGVudGlmaWVyLFxuICB9O1xuXG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIEJlZm9yZSBjYWxsaW5nIHRoZSB0cmlnZ2VyLCB2YWxpZGF0ZSB0aGUgcGVybWlzc2lvbnMgZm9yIHRoZSBzYXZlIG9wZXJhdGlvblxuICAgICAgbGV0IGRhdGFiYXNlUHJvbWlzZSA9IG51bGw7XG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgdXBkYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICB0cnVlLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFZhbGlkYXRlIGZvciBjcmVhdGluZ1xuICAgICAgICBkYXRhYmFzZVByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS5jcmVhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBJbiB0aGUgY2FzZSB0aGF0IHRoZXJlIGlzIG5vIHBlcm1pc3Npb24gZm9yIHRoZSBvcGVyYXRpb24sIGl0IHRocm93cyBhbiBlcnJvclxuICAgICAgcmV0dXJuIGRhdGFiYXNlUHJvbWlzZS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmICghcmVzdWx0IHx8IHJlc3VsdC5sZW5ndGggPD0gMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZC4nKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLFxuICAgICAgICB0aGlzLmF1dGgsXG4gICAgICAgIHVwZGF0ZWRPYmplY3QsXG4gICAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgICB0aGlzLmNvbmZpZyxcbiAgICAgICAgdGhpcy5jb250ZXh0XG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgaWYgKHJlc3BvbnNlICYmIHJlc3BvbnNlLm9iamVjdCkge1xuICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciA9IF8ucmVkdWNlKFxuICAgICAgICAgIHJlc3BvbnNlLm9iamVjdCxcbiAgICAgICAgICAocmVzdWx0LCB2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFcXVhbCh0aGlzLmRhdGFba2V5XSwgdmFsdWUpKSB7XG4gICAgICAgICAgICAgIHJlc3VsdC5wdXNoKGtleSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgIH0sXG4gICAgICAgICAgW11cbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5kYXRhID0gcmVzcG9uc2Uub2JqZWN0O1xuICAgICAgICAvLyBXZSBzaG91bGQgZGVsZXRlIHRoZSBvYmplY3RJZCBmb3IgYW4gdXBkYXRlIHdyaXRlXG4gICAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBVdGlscy5jaGVja1Byb2hpYml0ZWRLZXl3b3Jkcyh0aGlzLmNvbmZpZywgdGhpcy5kYXRhKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCBgJHtlcnJvcn1gKTtcbiAgICAgIH1cbiAgICAgIHRoaXMudmFsaWRhdGVEb3ROb3RhdGlvbktleXMoKTtcbiAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgLy8gVGhlIHRyaWdnZXIgbWF5IGhhdmUgc2V0IGZpbGUgcG9pbnRlcnMgd2l0aG91dCBVUkxcbiAgICAgICAgcmV0dXJuIHRoaXMucmVzb2x2ZUZpbGVVcmxzKCk7XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlciA9IGFzeW5jIGZ1bmN0aW9uICh1c2VyRGF0YSkge1xuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdiZWZvcmVMb2dpbicgdHJpZ2dlclxuICBpZiAoXG4gICAgIXRyaWdnZXJzLnRyaWdnZXJFeGlzdHModGhpcy5jbGFzc05hbWUsIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUxvZ2luLCB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkKVxuICApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBDbG91ZCBjb2RlIGdldHMgYSBiaXQgb2YgZXh0cmEgZGF0YSBmb3IgaXRzIG9iamVjdHNcbiAgY29uc3QgZXh0cmFEYXRhID0geyBjbGFzc05hbWU6IHRoaXMuY2xhc3NOYW1lIH07XG5cbiAgLy8gRXhwYW5kIGZpbGUgb2JqZWN0c1xuICBhd2FpdCB0aGlzLmNvbmZpZy5maWxlc0NvbnRyb2xsZXIuZXhwYW5kRmlsZXNJbk9iamVjdCh0aGlzLmNvbmZpZywgdXNlckRhdGEpO1xuXG4gIGNvbnN0IHVzZXIgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdXNlckRhdGEpO1xuXG4gIC8vIG5vIG5lZWQgdG8gcmV0dXJuIGEgcmVzcG9uc2VcbiAgYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKFxuICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUxvZ2luLFxuICAgIHRoaXMuYXV0aCxcbiAgICB1c2VyLFxuICAgIG51bGwsXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5jb250ZXh0XG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnNldFJlcXVpcmVkRmllbGRzSWZOZWVkZWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmRhdGEpIHtcbiAgICByZXR1cm4gdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIuZ2V0QWxsQ2xhc3NlcygpLnRoZW4oYWxsQ2xhc3NlcyA9PiB7XG4gICAgICBjb25zdCBzY2hlbWEgPSBhbGxDbGFzc2VzLmZpbmQob25lQ2xhc3MgPT4gb25lQ2xhc3MuY2xhc3NOYW1lID09PSB0aGlzLmNsYXNzTmFtZSk7XG4gICAgICBjb25zdCBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQgPSAoZmllbGROYW1lLCBzZXREZWZhdWx0KSA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkIHx8XG4gICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IG51bGwgfHxcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gJycgfHxcbiAgICAgICAgICAodHlwZW9mIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnb2JqZWN0JyAmJiB0aGlzLmRhdGFbZmllbGROYW1lXS5fX29wID09PSAnRGVsZXRlJylcbiAgICAgICAgKSB7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgc2V0RGVmYXVsdCAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlICE9PSBudWxsICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdFZhbHVlICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgICAgICh0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkIHx8XG4gICAgICAgICAgICAgICh0eXBlb2YgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09ICdvYmplY3QnICYmIHRoaXMuZGF0YVtmaWVsZE5hbWVdLl9fb3AgPT09ICdEZWxldGUnKSlcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID0gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZTtcbiAgICAgICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyID0gdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgfHwgW107XG4gICAgICAgICAgICBpZiAodGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuaW5kZXhPZihmaWVsZE5hbWUpIDwgMCkge1xuICAgICAgICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJlcXVpcmVkID09PSB0cnVlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUiwgYCR7ZmllbGROYW1lfSBpcyByZXF1aXJlZGApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgLy8gYWRkIGRlZmF1bHQgQUNMIChvbmx5IG9uIENSRUFURSwgbm90IFVQREFURSlcbiAgICAgIGlmICghdGhpcy5xdWVyeSAmJlxuICAgICAgICBzY2hlbWE/LmNsYXNzTGV2ZWxQZXJtaXNzaW9ucz8uQUNMICYmXG4gICAgICAgICF0aGlzLmRhdGEuQUNMICYmXG4gICAgICAgIEpTT04uc3RyaW5naWZ5KHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMuQUNMKSAhPT1cbiAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7ICcqJzogeyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9IH0pXG4gICAgICApIHtcbiAgICAgICAgY29uc3QgYWNsID0gc3RydWN0dXJlZENsb25lKHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMuQUNMKTtcbiAgICAgICAgaWYgKGFjbC5jdXJyZW50VXNlcikge1xuICAgICAgICAgIGlmICh0aGlzLmF1dGgudXNlcj8uaWQpIHtcbiAgICAgICAgICAgIGFjbFt0aGlzLmF1dGgudXNlcj8uaWRdID0gc3RydWN0dXJlZENsb25lKGFjbC5jdXJyZW50VXNlcik7XG4gICAgICAgICAgfVxuICAgICAgICAgIGRlbGV0ZSBhY2wuY3VycmVudFVzZXI7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5kYXRhLkFDTCA9IGFjbDtcbiAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciB8fCBbXTtcbiAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIucHVzaCgnQUNMJyk7XG4gICAgICB9XG5cbiAgICAgIC8vIEFkZCBkZWZhdWx0IGZpZWxkc1xuICAgICAgaWYgKCF0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIC8vIGFsbG93IGN1c3RvbWl6aW5nIGNyZWF0ZWRBdCBhbmQgdXBkYXRlZEF0IHdoZW4gdXNpbmcgbWFpbnRlbmFuY2Uga2V5XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0Ll9fdHlwZSA9PT0gJ0RhdGUnXG4gICAgICAgICkge1xuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0LmlzbztcblxuICAgICAgICAgIGlmICh0aGlzLmRhdGEudXBkYXRlZEF0ICYmIHRoaXMuZGF0YS51cGRhdGVkQXQuX190eXBlID09PSAnRGF0ZScpIHtcbiAgICAgICAgICAgIGNvbnN0IGNyZWF0ZWRBdCA9IG5ldyBEYXRlKHRoaXMuZGF0YS5jcmVhdGVkQXQpO1xuICAgICAgICAgICAgY29uc3QgdXBkYXRlZEF0ID0gbmV3IERhdGUodGhpcy5kYXRhLnVwZGF0ZWRBdC5pc28pO1xuXG4gICAgICAgICAgICBpZiAodXBkYXRlZEF0IDwgY3JlYXRlZEF0KSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgICd1cGRhdGVkQXQgY2Fubm90IG9jY3VyIGJlZm9yZSBjcmVhdGVkQXQnXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLmRhdGEudXBkYXRlZEF0LmlzbztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gaWYgbm8gdXBkYXRlZEF0IGlzIHByb3ZpZGVkLCBzZXQgaXQgdG8gY3JlYXRlZEF0IHRvIG1hdGNoIGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gT25seSBhc3NpZ24gbmV3IG9iamVjdElkIGlmIHdlIGFyZSBjcmVhdGluZyBuZXcgb2JqZWN0XG4gICAgICAgIGlmICghdGhpcy5kYXRhLm9iamVjdElkKSB7XG4gICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gY3J5cHRvVXRpbHMubmV3T2JqZWN0SWQodGhpcy5jb25maWcub2JqZWN0SWRTaXplKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2NoZW1hKSB7XG4gICAgICAgICAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgc2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkKGZpZWxkTmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcblxuICAgICAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQoZmllbGROYW1lLCBmYWxzZSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cbi8vIFRyYW5zZm9ybXMgYXV0aCBkYXRhIGZvciBhIHVzZXIgb2JqZWN0LlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYSB1c2VyIG9iamVjdC5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVBdXRoRGF0YSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYXV0aERhdGEgPSB0aGlzLmRhdGEuYXV0aERhdGE7XG4gIGNvbnN0IGhhc1VzZXJuYW1lQW5kUGFzc3dvcmQgPVxuICAgIHR5cGVvZiB0aGlzLmRhdGEudXNlcm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiB0aGlzLmRhdGEucGFzc3dvcmQgPT09ICdzdHJpbmcnO1xuICBjb25zdCBoYXNBdXRoRGF0YSA9XG4gICAgYXV0aERhdGEgJiZcbiAgICBPYmplY3Qua2V5cyhhdXRoRGF0YSkuc29tZShwcm92aWRlciA9PiB7XG4gICAgICBjb25zdCBwcm92aWRlckRhdGEgPSBhdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICByZXR1cm4gcHJvdmlkZXJEYXRhICYmIHR5cGVvZiBwcm92aWRlckRhdGEgPT09ICdvYmplY3QnICYmIE9iamVjdC5rZXlzKHByb3ZpZGVyRGF0YSkubGVuZ3RoO1xuICAgIH0pO1xuXG4gIGNvbnN0IHJlcXVpcmVzQ3JlZGVudGlhbHMgPSAhdGhpcy5xdWVyeSAmJiAhaGFzQXV0aERhdGE7XG4gIGNvbnN0IGlzTWlzc2luZyA9IHZhbHVlID0+IHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycgfHwgXy5pc0VtcHR5KHZhbHVlKTtcbiAgLy8gQW4gZW1wdHkgdXNlcm5hbWUgb24gY3JlYXRlIHdpdGggYXV0aERhdGEgaXMgcmVwbGFjZWQgYnkgYSByYW5kb20gb25lXG4gIGNvbnN0IGNoZWNrVXNlcm5hbWUgPSByZXF1aXJlc0NyZWRlbnRpYWxzIHx8ICh0aGlzLnF1ZXJ5ICYmIHRoaXMuZGF0YS51c2VybmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgY29uc3QgY2hlY2tQYXNzd29yZCA9IHJlcXVpcmVzQ3JlZGVudGlhbHMgfHwgdGhpcy5kYXRhLnBhc3N3b3JkICE9PSB1bmRlZmluZWQ7XG4gIGlmIChjaGVja1VzZXJuYW1lICYmIGlzTWlzc2luZyh0aGlzLmRhdGEudXNlcm5hbWUpKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlVTRVJOQU1FX01JU1NJTkcsICdiYWQgb3IgbWlzc2luZyB1c2VybmFtZScpO1xuICB9XG4gIGlmIChjaGVja1Bhc3N3b3JkICYmIGlzTWlzc2luZyh0aGlzLmRhdGEucGFzc3dvcmQpKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlBBU1NXT1JEX01JU1NJTkcsICdwYXNzd29yZCBpcyByZXF1aXJlZCcpO1xuICB9XG5cbiAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwodGhpcy5kYXRhLCAnYXV0aERhdGEnKSkge1xuICAgIC8vIE5vdGhpbmcgdG8gdmFsaWRhdGUgaGVyZVxuICAgIHJldHVybjtcbiAgfSBlbHNlIGlmICghdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgLy8gSGFuZGxlIHNhdmluZyBhdXRoRGF0YSB0byBudWxsXG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuVU5TVVBQT1JURURfU0VSVklDRSxcbiAgICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICAgKTtcbiAgfVxuXG4gIHZhciBwcm92aWRlcnMgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSk7XG4gIGlmICghcHJvdmlkZXJzLmxlbmd0aCkge1xuICAgIC8vIEVtcHR5IGF1dGhEYXRhIG9iamVjdCwgbm90aGluZyB0byB2YWxpZGF0ZVxuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBjYW5IYW5kbGVBdXRoRGF0YSA9IHByb3ZpZGVycy5zb21lKHByb3ZpZGVyID0+IHtcbiAgICBjb25zdCBwcm92aWRlckF1dGhEYXRhID0gYXV0aERhdGFbcHJvdmlkZXJdIHx8IHt9O1xuICAgIHJldHVybiAhIU9iamVjdC5rZXlzKHByb3ZpZGVyQXV0aERhdGEpLmxlbmd0aDtcbiAgfSk7XG4gIGlmIChjYW5IYW5kbGVBdXRoRGF0YSB8fCBoYXNVc2VybmFtZUFuZFBhc3N3b3JkIHx8IHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmdldFVzZXJJZCgpKSB7XG4gICAgcmV0dXJuIHRoaXMuaGFuZGxlQXV0aERhdGEoYXV0aERhdGEpO1xuICB9XG4gIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbHRlcmVkT2JqZWN0c0J5QUNMID0gZnVuY3Rpb24gKG9iamVjdHMpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybiBvYmplY3RzO1xuICB9XG4gIHJldHVybiBvYmplY3RzLmZpbHRlcihvYmplY3QgPT4ge1xuICAgIGlmICghb2JqZWN0LkFDTCkge1xuICAgICAgcmV0dXJuIHRydWU7IC8vIGxlZ2FjeSB1c2VycyB0aGF0IGhhdmUgbm8gQUNMIGZpZWxkIG9uIHRoZW1cbiAgICB9XG4gICAgLy8gUmVndWxhciB1c2VycyB0aGF0IGhhdmUgYmVlbiBsb2NrZWQgb3V0LlxuICAgIHJldHVybiBvYmplY3QuQUNMICYmIE9iamVjdC5rZXlzKG9iamVjdC5BQ0wpLmxlbmd0aCA+IDA7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VySWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gdGhpcy5xdWVyeS5vYmplY3RJZDtcbiAgfSBlbHNlIGlmICh0aGlzLmF1dGggJiYgdGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLnVzZXIuaWQ7XG4gIH1cbn07XG5cbi8vIERldmVsb3BlcnMgYXJlIGFsbG93ZWQgdG8gY2hhbmdlIGF1dGhEYXRhIHZpYSBiZWZvcmUgc2F2ZSB0cmlnZ2VyXG5SZXN0V3JpdGUucHJvdG90eXBlLl90aHJvd0lmQXV0aERhdGFEdXBsaWNhdGUgPSBmdW5jdGlvbiAoZXJyb3IpIHtcbiAgaWYgKFxuICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgZXJyb3I/LmNvZGUgPT09IFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSAmJlxuICAgIGVycm9yLnVzZXJJbmZvPy5kdXBsaWNhdGVkX2ZpZWxkPy5zdGFydHNXaXRoKCdfYXV0aF9kYXRhXycpXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG59O1xuXG4vLyB3ZSBuZWVkIGFmdGVyIGJlZm9yZSBzYXZlIHRvIGVuc3VyZSB0aGF0IHRoZSBkZXZlbG9wZXJcbi8vIGlzIG5vdCBjdXJyZW50bHkgZHVwbGljYXRpbmcgYXV0aCBkYXRhIElEXG5SZXN0V3JpdGUucHJvdG90eXBlLmVuc3VyZVVuaXF1ZUF1dGhEYXRhSWQgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaGFzQXV0aERhdGFJZCA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkuc29tZShcbiAgICBrZXkgPT4gdGhpcy5kYXRhLmF1dGhEYXRhW2tleV0gJiYgdGhpcy5kYXRhLmF1dGhEYXRhW2tleV0uaWRcbiAgKTtcblxuICBpZiAoIWhhc0F1dGhEYXRhSWQpIHsgcmV0dXJuOyB9XG5cbiAgY29uc3QgciA9IGF3YWl0IEF1dGguZmluZFVzZXJzV2l0aEF1dGhEYXRhKHRoaXMuY29uZmlnLCB0aGlzLmRhdGEuYXV0aERhdGEpO1xuICBjb25zdCByZXN1bHRzID0gdGhpcy5maWx0ZXJlZE9iamVjdHNCeUFDTChyKTtcbiAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG4gIC8vIHVzZSBkYXRhLm9iamVjdElkIGluIGNhc2Ugb2YgbG9naW4gdGltZSBhbmQgZm91bmQgdXNlciBkdXJpbmcgaGFuZGxlIHZhbGlkYXRlQXV0aERhdGFcbiAgY29uc3QgdXNlcklkID0gdGhpcy5nZXRVc2VySWQoKSB8fCB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gIGlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMSAmJiB1c2VySWQgIT09IHJlc3VsdHNbMF0ub2JqZWN0SWQpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuQUNDT1VOVF9BTFJFQURZX0xJTktFRCwgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVBdXRoRGF0YSA9IGFzeW5jIGZ1bmN0aW9uIChhdXRoRGF0YSkge1xuICBsZXQgY3VycmVudFVzZXJBdXRoRGF0YTtcbiAgaWYgKHRoaXMucXVlcnk/Lm9iamVjdElkKSB7XG4gICAgY29uc3QgW2N1cnJlbnRVc2VyXSA9IGF3YWl0IHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAnX1VzZXInLFxuICAgICAgeyBvYmplY3RJZDogdGhpcy5xdWVyeS5vYmplY3RJZCB9XG4gICAgKTtcbiAgICBjdXJyZW50VXNlckF1dGhEYXRhID0gY3VycmVudFVzZXI/LmF1dGhEYXRhO1xuICB9XG4gIGNvbnN0IHIgPSBhd2FpdCBBdXRoLmZpbmRVc2Vyc1dpdGhBdXRoRGF0YSh0aGlzLmNvbmZpZywgYXV0aERhdGEsIHRydWUsIGN1cnJlbnRVc2VyQXV0aERhdGEpO1xuICBjb25zdCByZXN1bHRzID0gdGhpcy5maWx0ZXJlZE9iamVjdHNCeUFDTChyKTtcblxuICBjb25zdCB1c2VySWQgPSB0aGlzLmdldFVzZXJJZCgpO1xuICBjb25zdCBpc0xvZ2luID0gIXVzZXJJZDtcbiAgY29uc3QgdXNlclJlc3VsdCA9IHJlc3VsdHNbMF07XG4gIGNvbnN0IGZvdW5kVXNlcklzTm90Q3VycmVudFVzZXIgPSB1c2VySWQgJiYgdXNlclJlc3VsdCAmJiB1c2VySWQgIT09IHVzZXJSZXN1bHQub2JqZWN0SWQ7XG5cbiAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMSB8fCBmb3VuZFVzZXJJc05vdEN1cnJlbnRVc2VyKSB7XG4gICAgLy8gVG8gYXZvaWQgaHR0cHM6Ly9naXRodWIuY29tL3BhcnNlLWNvbW11bml0eS9wYXJzZS1zZXJ2ZXIvc2VjdXJpdHkvYWR2aXNvcmllcy9HSFNBLTh3M2otZzk4My04amg1XG4gICAgLy8gTGV0J3MgcnVuIHNvbWUgdmFsaWRhdGlvbiBiZWZvcmUgdGhyb3dpbmdcbiAgICBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihhdXRoRGF0YSwgdGhpcywgdXNlclJlc3VsdCwgeyBpc0xvZ2luIH0pO1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG5cbiAgLy8gTm8gdXNlciBmb3VuZCB3aXRoIHByb3ZpZGVkIGF1dGhEYXRhIHdlIG5lZWQgdG8gdmFsaWRhdGVcbiAgaWYgKCFyZXN1bHRzLmxlbmd0aCkge1xuICAgIGNvbnN0IHsgYXV0aERhdGE6IHZhbGlkYXRlZEF1dGhEYXRhLCBhdXRoRGF0YVJlc3BvbnNlIH0gPSBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihcbiAgICAgIGF1dGhEYXRhLFxuICAgICAgdGhpcyxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIHsgaXNMb2dpbiB9XG4gICAgKTtcbiAgICB0aGlzLmF1dGhEYXRhUmVzcG9uc2UgPSBhdXRoRGF0YVJlc3BvbnNlO1xuICAgIC8vIFJlcGxhY2UgY3VycmVudCBhdXRoRGF0YSBieSB0aGUgbmV3IHZhbGlkYXRlZCBvbmVcbiAgICB0aGlzLmRhdGEuYXV0aERhdGEgPSB2YWxpZGF0ZWRBdXRoRGF0YTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBVc2VyIGZvdW5kIHdpdGggcHJvdmlkZWQgYXV0aERhdGFcbiAgaWYgKHJlc3VsdHMubGVuZ3RoID09PSAxKSB7XG4gICAgdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKS5qb2luKCcsJyk7XG5cbiAgICBjb25zdCB7IGhhc011dGF0ZWRBdXRoRGF0YSwgbXV0YXRlZEF1dGhEYXRhIH0gPSBBdXRoLmhhc011dGF0ZWRBdXRoRGF0YShcbiAgICAgIGF1dGhEYXRhLFxuICAgICAgdXNlclJlc3VsdC5hdXRoRGF0YVxuICAgICk7XG5cbiAgICBjb25zdCBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIgPVxuICAgICAgKHRoaXMuYXV0aCAmJiB0aGlzLmF1dGgudXNlciAmJiB0aGlzLmF1dGgudXNlci5pZCA9PT0gdXNlclJlc3VsdC5vYmplY3RJZCkgfHxcbiAgICAgIHRoaXMuYXV0aC5pc01hc3RlcjtcblxuICAgIGlmIChpc0xvZ2luIHx8IGlzQ3VycmVudFVzZXJMb2dnZWRPck1hc3Rlcikge1xuICAgICAgLy8gbm8gdXNlciBtYWtpbmcgdGhlIGNhbGxcbiAgICAgIC8vIE9SIHRoZSB1c2VyIG1ha2luZyB0aGUgY2FsbCBpcyB0aGUgcmlnaHQgb25lXG4gICAgICAvLyBMb2dpbiB3aXRoIGF1dGggZGF0YVxuICAgICAgZGVsZXRlIHJlc3VsdHNbMF0ucGFzc3dvcmQ7XG5cbiAgICAgIC8vIG5lZWQgdG8gc2V0IHRoZSBvYmplY3RJZCBmaXJzdCBvdGhlcndpc2UgbG9jYXRpb24gaGFzIHRyYWlsaW5nIHVuZGVmaW5lZFxuICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gdXNlclJlc3VsdC5vYmplY3RJZDtcblxuICAgICAgaWYgKCF0aGlzLnF1ZXJ5IHx8ICF0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgICAgcmVzcG9uc2U6IHVzZXJSZXN1bHQsXG4gICAgICAgICAgbG9jYXRpb246IHRoaXMubG9jYXRpb24oKSxcbiAgICAgICAgfTtcbiAgICAgICAgLy8gUnVuIGJlZm9yZUxvZ2luIGhvb2sgYmVmb3JlIHN0b3JpbmcgYW55IHVwZGF0ZXNcbiAgICAgICAgLy8gdG8gYXV0aERhdGEgb24gdGhlIGRiOyBjaGFuZ2VzIHRvIHVzZXJSZXN1bHRcbiAgICAgICAgLy8gd2lsbCBiZSBpZ25vcmVkLlxuICAgICAgICBhd2FpdCB0aGlzLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlcihzdHJ1Y3R1cmVkQ2xvbmUodXNlclJlc3VsdCkpO1xuXG4gICAgICAgIC8vIElmIHdlIGFyZSBpbiBsb2dpbiBvcGVyYXRpb24gdmlhIGF1dGhEYXRhXG4gICAgICAgIC8vIHdlIG5lZWQgdG8gYmUgc3VyZSB0aGF0IHRoZSB1c2VyIGhhcyBwcm92aWRlZFxuICAgICAgICAvLyByZXF1aXJlZCBhdXRoRGF0YVxuICAgICAgICBBdXRoLmNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4oXG4gICAgICAgICAgeyBjb25maWc6IHRoaXMuY29uZmlnLCBhdXRoOiB0aGlzLmF1dGggfSxcbiAgICAgICAgICBhdXRoRGF0YSxcbiAgICAgICAgICB1c2VyUmVzdWx0LmF1dGhEYXRhLFxuICAgICAgICAgIHRoaXMuY29uZmlnXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIC8vIFByZXZlbnQgdmFsaWRhdGluZyBpZiBubyBtdXRhdGVkIGRhdGEgZGV0ZWN0ZWQgb24gdXBkYXRlXG4gICAgICBpZiAoIWlzTG9naW4gJiYgIWhhc011dGF0ZWRBdXRoRGF0YSAmJiBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBBbHdheXMgdmFsaWRhdGUgYWxsIHByb3ZpZGVkIGF1dGhEYXRhIG9uIGxvZ2luIHRvIHByZXZlbnQgYXV0aGVudGljYXRpb25cbiAgICAgIC8vIGJ5cGFzcyB2aWEgcGFydGlhbCBhdXRoRGF0YSAoZS5nLiBzZW5kaW5nIG9ubHkgdGhlIHByb3ZpZGVyIElEIHdpdGhvdXRcbiAgICAgIC8vIGFuIGFjY2VzcyB0b2tlbik7IG9uIHVwZGF0ZSBvbmx5IHZhbGlkYXRlIG11dGF0ZWQgb25lc1xuICAgICAgaWYgKGlzTG9naW4gfHwgaGFzTXV0YXRlZEF1dGhEYXRhIHx8ICF0aGlzLmNvbmZpZy5hbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuKSB7XG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IEF1dGguaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKFxuICAgICAgICAgIGlzTG9naW4gPyBhdXRoRGF0YSA6IG11dGF0ZWRBdXRoRGF0YSxcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgIHVzZXJSZXN1bHQsXG4gICAgICAgICAgeyBpc0xvZ2luIH1cbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5kYXRhLmF1dGhEYXRhID0gcmVzLmF1dGhEYXRhO1xuICAgICAgICB0aGlzLmF1dGhEYXRhUmVzcG9uc2UgPSByZXMuYXV0aERhdGFSZXNwb25zZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2FwdHVyZSBvcmlnaW5hbCBhdXRoRGF0YSBiZWZvcmUgbXV0YXRpbmcgdXNlclJlc3VsdCB2aWEgdGhlIHJlc3BvbnNlIHJlZmVyZW5jZVxuICAgICAgY29uc3Qgb3JpZ2luYWxBdXRoRGF0YSA9IHVzZXJSZXN1bHQ/LmF1dGhEYXRhXG4gICAgICAgID8gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgIE9iamVjdC5lbnRyaWVzKHVzZXJSZXN1bHQuYXV0aERhdGEpLm1hcCgoW2ssIHZdKSA9PlxuICAgICAgICAgICAgW2ssIHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnID8geyAuLi52IH0gOiB2XVxuICAgICAgICAgIClcbiAgICAgICAgKVxuICAgICAgICA6IHVuZGVmaW5lZDtcblxuICAgICAgLy8gSUYgd2UgYXJlIGluIGxvZ2luIHdlJ2xsIHNraXAgdGhlIGRhdGFiYXNlIG9wZXJhdGlvbiAvIGJlZm9yZVNhdmUgLyBhZnRlclNhdmUgZXRjLi4uXG4gICAgICAvLyB3ZSBuZWVkIHRvIHNldCBpdCB1cCB0aGVyZS5cbiAgICAgIC8vIFdlIGFyZSBzdXBwb3NlZCB0byBoYXZlIGEgcmVzcG9uc2Ugb25seSBvbiBMT0dJTiB3aXRoIGF1dGhEYXRhLCBzbyB3ZSBza2lwIHRob3NlXG4gICAgICAvLyBJZiB3ZSdyZSBub3QgbG9nZ2luZyBpbiwgYnV0IGp1c3QgdXBkYXRpbmcgdGhlIGN1cnJlbnQgdXNlciwgd2UgY2FuIHNhZmVseSBza2lwIHRoYXQgcGFydFxuICAgICAgaWYgKHRoaXMucmVzcG9uc2UpIHtcbiAgICAgICAgLy8gQXNzaWduIHRoZSBuZXcgYXV0aERhdGEgaW4gdGhlIHJlc3BvbnNlXG4gICAgICAgIE9iamVjdC5rZXlzKG11dGF0ZWRBdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5hdXRoRGF0YVtwcm92aWRlcl0gPSBtdXRhdGVkQXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBSdW4gdGhlIERCIHVwZGF0ZSBkaXJlY3RseSwgYXMgJ21hc3Rlcicgb25seSBpZiBhdXRoRGF0YSBjb250YWlucyBzb21lIGtleXNcbiAgICAgICAgLy8gYXV0aERhdGEgY291bGQgbm90IGNvbnRhaW5zIGtleXMgYWZ0ZXIgdmFsaWRhdGlvbiBpZiB0aGUgYXV0aEFkYXB0ZXJcbiAgICAgICAgLy8gdXNlcyB0aGUgYGRvTm90U2F2ZWAgb3B0aW9uLiBKdXN0IHVwZGF0ZSB0aGUgYXV0aERhdGEgcGFydFxuICAgICAgICAvLyBUaGVuIHdlJ3JlIGdvb2QgZm9yIHRoZSB1c2VyLCBlYXJseSBleGl0IG9mIHNvcnRzXG4gICAgICAgIGlmIChPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCkge1xuICAgICAgICAgIGNvbnN0IHF1ZXJ5ID0geyBvYmplY3RJZDogdGhpcy5kYXRhLm9iamVjdElkIH07XG4gICAgICAgICAgLy8gT3B0aW1pc3RpYyBsb2NraW5nOiBpbmNsdWRlIGVhY2ggY2hhbmdlZCBvcmlnaW5hbCBmaWVsZCBpbiB0aGUgV0hFUkUgY2xhdXNlXG4gICAgICAgICAgLy8gZm9yIHByb3ZpZGVycyB3aG9zZSBkYXRhIGlzIGJlaW5nIHVwZGF0ZWQuIFRoaXMgcHJldmVudHMgY29uY3VycmVudCByZXF1ZXN0c1xuICAgICAgICAgIC8vIGZyb20gYm90aCBzdWNjZWVkaW5nIHdoZW4gY29uc3VtaW5nIHNpbmdsZS11c2UgdG9rZW5zIChlLmcuIE1GQSByZWNvdmVyeSBjb2Rlc1xuICAgICAgICAgIC8vIGFzIGFycmF5cywgb3IgTUZBIFNNUyBPVFAgdG9rZW5zIGFzIHN0cmluZ3MpLlxuICAgICAgICAgIGFwcGx5QXV0aERhdGFPcHRpbWlzdGljTG9jayhxdWVyeSwgb3JpZ2luYWxBdXRoRGF0YSwgdGhpcy5kYXRhLmF1dGhEYXRhKTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgIHsgYXV0aERhdGE6IHRoaXMuZGF0YS5hdXRoRGF0YSB9LFxuICAgICAgICAgICAgICB7fVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsICdJbnZhbGlkIGF1dGggZGF0YScpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5fdGhyb3dJZkF1dGhEYXRhRHVwbGljYXRlKGVycm9yKTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMuZGF0YS5hdXRoRGF0YSAmJiBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCkge1xuICAgICAgICAvLyBVUERBVEUgcGF0aCAoZS5nLiBQVVQgL3VzZXJzLzppZCBkdXJpbmcgbGlua2VkLXByb3ZpZGVyIHJlLWF1dGgpOiBhcHBseVxuICAgICAgICAvLyB0aGUgc2FtZSBvcHRpbWlzdGljIGxvY2sgdG8gdGhlIHN1YnNlcXVlbnQgcnVuRGF0YWJhc2VPcGVyYXRpb24gdXBkYXRlIHNvXG4gICAgICAgIC8vIGNvbmN1cnJlbnQgc2luZ2xlLXVzZSB0b2tlbiBjb25zdW1lcnMgY2Fubm90IGJvdGggc3VjY2VlZC5cbiAgICAgICAgYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrKHRoaXMucXVlcnksIG9yaWdpbmFsQXV0aERhdGEsIHRoaXMuZGF0YS5hdXRoRGF0YSk7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG4vLyBSZWplY3RzIGludGVybmFsIGZpZWxkcyBpbiBjbGllbnQtc3VwcGxpZWQgZGF0YVxuUmVzdFdyaXRlLnByb3RvdHlwZS5jaGVja0ludGVybmFsRmllbGRzID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3QgZmllbGROYW1lIGluIHRoaXMuZGF0YSkge1xuICAgIGlmIChmaWVsZE5hbWUuY2hhckF0KDApID09PSAnXycpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCBgSW52YWxpZCBmaWVsZCBuYW1lOiAke2ZpZWxkTmFtZX0uYCk7XG4gICAgfVxuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNoZWNrUmVzdHJpY3RlZEZpZWxkcyA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICdlbWFpbFZlcmlmaWVkJyBpbiB0aGlzLmRhdGEpIHtcbiAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICBcIkNsaWVudHMgYXJlbid0IGFsbG93ZWQgdG8gbWFudWFsbHkgdXBkYXRlIGVtYWlsIHZlcmlmaWNhdGlvbi5cIixcbiAgICAgIHRoaXMuY29uZmlnXG4gICAgKTtcbiAgfVxufTtcblxuLy8gVmFsaWRhdGVzIHRoZSBjcmVhdGUgb3IgdXBkYXRlIGNsYXNzLWxldmVsIHBlcm1pc3Npb24gYmVmb3JlIHNjaGVtYSB2YWxpZGF0aW9uXG5SZXN0V3JpdGUucHJvdG90eXBlLnZhbGlkYXRlV3JpdGVQZXJtaXNzaW9uID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHNjaGVtYUNvbnRyb2xsZXIgPSBhd2FpdCB0aGlzLmNvbmZpZy5kYXRhYmFzZS5sb2FkU2NoZW1hKCk7XG4gIGF3YWl0IHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRoaXMucnVuT3B0aW9ucy5hY2wgfHwgW10sXG4gICAgdGhpcy5xdWVyeSA/ICd1cGRhdGUnIDogJ2NyZWF0ZSdcbiAgKTtcbn07XG5cbi8vIEF1dGhvcml6ZSBhIF9Vc2VyIHVwZGF0ZSBiZWZvcmUgYW55IHN0ZXAgcmVhZHMgdGhlIHRhcmdldCBhY2NvdW50XG5SZXN0V3JpdGUucHJvdG90eXBlLmF1dGhvcml6ZVVzZXJVcGRhdGUgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCAhdGhpcy5xdWVyeSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aGlzLmF1dGguaXNVbmF1dGhlbnRpY2F0ZWQoKSkge1xuICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuU0VTU0lPTl9NSVNTSU5HLFxuICAgICAgYENhbm5vdCBtb2RpZnkgdXNlciAke3RoaXMucXVlcnkub2JqZWN0SWR9LmAsXG4gICAgICB0aGlzLmNvbmZpZ1xuICAgICk7XG4gIH1cbiAgLy8gQm9keSBvYmplY3RJZCBtdXN0IG5vdCByZXRhcmdldCB0aGUgdXBkYXRlXG4gIGlmICh0aGlzLmRhdGEub2JqZWN0SWQgIT09IHVuZGVmaW5lZCAmJiB0aGlzLmRhdGEub2JqZWN0SWQgIT09IHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQuJyk7XG4gIH1cbiAgLy8gT3duZXIgdXBkYXRlIHJlYWRzIG9ubHkgb3duIGRhdGE7IHRoZSB3cml0ZSBzdGF5cyBBQ0wtY2hlY2tlZFxuICBpZiAodGhpcy5hdXRoLnVzZXIuaWQgPT09IHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gV3JpdGUgYWNjZXNzIGNoZWNrIHZpYSB0aGUgd3JpdGUtcGF0aCBBQ0wgZW5mb3JjZW1lbnRcbiAgYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHsgb2JqZWN0SWQ6IHRoaXMucXVlcnkub2JqZWN0SWQgfSxcbiAgICB7fSxcbiAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgZmFsc2UsXG4gICAgdHJ1ZVxuICApO1xufTtcblxuLy8gVGhlIG5vbi10aGlyZC1wYXJ0eSBwYXJ0cyBvZiBVc2VyIHRyYW5zZm9ybWF0aW9uXG5SZXN0V3JpdGUucHJvdG90eXBlLnRyYW5zZm9ybVVzZXIgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIHZhciBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG5cbiAgLy8gRG8gbm90IGNsZWFudXAgc2Vzc2lvbiBpZiBvYmplY3RJZCBpcyBub3Qgc2V0XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMub2JqZWN0SWQoKSkge1xuICAgIC8vIElmIHdlJ3JlIHVwZGF0aW5nIGEgX1VzZXIgb2JqZWN0LCB3ZSBuZWVkIHRvIGNsZWFyIG91dCB0aGUgY2FjaGUgZm9yIHRoYXQgdXNlci4gRmluZCBhbGwgdGhlaXJcbiAgICAvLyBzZXNzaW9uIHRva2VucywgYW5kIHJlbW92ZSB0aGVtIGZyb20gdGhlIGNhY2hlLlxuICAgIGNvbnN0IHF1ZXJ5ID0gYXdhaXQgUmVzdFF1ZXJ5KHtcbiAgICAgIG1ldGhvZDogUmVzdFF1ZXJ5Lk1ldGhvZC5maW5kLFxuICAgICAgY29uZmlnOiB0aGlzLmNvbmZpZyxcbiAgICAgIGF1dGg6IEF1dGgubWFzdGVyKHRoaXMuY29uZmlnKSxcbiAgICAgIGNsYXNzTmFtZTogJ19TZXNzaW9uJyxcbiAgICAgIHJ1bkJlZm9yZUZpbmQ6IGZhbHNlLFxuICAgICAgcmVzdFdoZXJlOiB7XG4gICAgICAgIHVzZXI6IHtcbiAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgcHJvbWlzZSA9IHF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgcmVzdWx0cy5yZXN1bHRzLmZvckVhY2goc2Vzc2lvbiA9PlxuICAgICAgICB0aGlzLmNvbmZpZy5jYWNoZUNvbnRyb2xsZXIudXNlci5kZWwoc2Vzc2lvbi5zZXNzaW9uVG9rZW4pXG4gICAgICApO1xuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHByb21pc2VcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICAvLyBUcmFuc2Zvcm0gdGhlIHBhc3N3b3JkXG4gICAgICBpZiAodGhpcy5kYXRhLnBhc3N3b3JkID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgLy8gaWdub3JlIG9ubHkgaWYgdW5kZWZpbmVkLiBzaG91bGQgcHJvY2VlZCBpZiBlbXB0eSAoJycpXG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICAgICAgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ10gPSB0cnVlO1xuICAgICAgICAvLyBHZW5lcmF0ZSBhIG5ldyBzZXNzaW9uIG9ubHkgaWYgdGhlIHVzZXIgcmVxdWVzdGVkXG4gICAgICAgIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgICAgICAgIHRoaXMuc3RvcmFnZVsnZ2VuZXJhdGVOZXdTZXNzaW9uJ10gPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVBhc3N3b3JkUG9saWN5KCkudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBwYXNzd29yZENyeXB0by5oYXNoKHRoaXMuZGF0YS5wYXNzd29yZCkudGhlbihoYXNoZWRQYXNzd29yZCA9PiB7XG4gICAgICAgICAgdGhpcy5kYXRhLl9oYXNoZWRfcGFzc3dvcmQgPSBoYXNoZWRQYXNzd29yZDtcbiAgICAgICAgICBkZWxldGUgdGhpcy5kYXRhLnBhc3N3b3JkO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlVXNlck5hbWUoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZUVtYWlsKCk7XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVVzZXJOYW1lID0gZnVuY3Rpb24gKCkge1xuICAvLyBDaGVjayBmb3IgdXNlcm5hbWUgdW5pcXVlbmVzc1xuICBpZiAoIXRoaXMuZGF0YS51c2VybmFtZSkge1xuICAgIGlmICghdGhpcy5xdWVyeSkge1xuICAgICAgdGhpcy5kYXRhLnVzZXJuYW1lID0gY3J5cHRvVXRpbHMucmFuZG9tU3RyaW5nKDI1KTtcbiAgICAgIHRoaXMucmVzcG9uc2VTaG91bGRIYXZlVXNlcm5hbWUgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLypcbiAgICBVc2VybmFtZXMgc2hvdWxkIGJlIHVuaXF1ZSB3aGVuIGNvbXBhcmVkIGNhc2UgaW5zZW5zaXRpdmVseVxuXG4gICAgVXNlcnMgc2hvdWxkIGJlIGFibGUgdG8gbWFrZSBjYXNlIHNlbnNpdGl2ZSB1c2VybmFtZXMgYW5kXG4gICAgbG9naW4gdXNpbmcgdGhlIGNhc2UgdGhleSBlbnRlcmVkLiAgSS5lLiAnU25vb3B5JyBzaG91bGQgcHJlY2x1ZGVcbiAgICAnc25vb3B5JyBhcyBhIHZhbGlkIHVzZXJuYW1lLlxuICAqL1xuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZChcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAge1xuICAgICAgICB1c2VybmFtZTogdGhpcy5kYXRhLnVzZXJuYW1lLFxuICAgICAgICBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgfSxcbiAgICAgIHsgbGltaXQ6IDEsIGNhc2VJbnNlbnNpdGl2ZTogdHJ1ZSB9LFxuICAgICAge30sXG4gICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgIClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOLFxuICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5idWlsZENyZWF0ZWRXaXRoID0gZnVuY3Rpb24gKGFjdGlvbiwgYXV0aFByb3ZpZGVyKSB7XG4gIHJldHVybiB7IGFjdGlvbiwgYXV0aFByb3ZpZGVyOiBhdXRoUHJvdmlkZXIgfHwgJ3Bhc3N3b3JkJyB9O1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRDcmVhdGVkV2l0aCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuc3RvcmFnZS5jcmVhdGVkV2l0aCkge1xuICAgIHJldHVybiB0aGlzLnN0b3JhZ2UuY3JlYXRlZFdpdGg7XG4gIH1cbiAgY29uc3QgaXNDcmVhdGVPcGVyYXRpb24gPSAhdGhpcy5xdWVyeTtcbiAgY29uc3QgYXV0aERhdGFQcm92aWRlciA9XG4gICAgdGhpcy5kYXRhPy5hdXRoRGF0YSAmJlxuICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoICYmXG4gICAgT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5qb2luKCcsJyk7XG4gIGNvbnN0IGF1dGhQcm92aWRlciA9IHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgfHwgYXV0aERhdGFQcm92aWRlcjtcbiAgLy8gc3RvcmFnZS5hdXRoUHJvdmlkZXIgaXMgb25seSBzZXQgZm9yIGxvZ2luIChleGlzdGluZyB1c2VyIGZvdW5kIGluIGhhbmRsZUF1dGhEYXRhKVxuICBjb25zdCBhY3Rpb24gPSB0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyID8gJ2xvZ2luJyA6IGlzQ3JlYXRlT3BlcmF0aW9uID8gJ3NpZ251cCcgOiB1bmRlZmluZWQ7XG4gIGlmICghYWN0aW9uKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJlc29sdmVkQXV0aFByb3ZpZGVyID0gYXV0aFByb3ZpZGVyIHx8IChhY3Rpb24gPT09ICdzaWdudXAnID8gJ3Bhc3N3b3JkJyA6IHVuZGVmaW5lZCk7XG4gIHRoaXMuc3RvcmFnZS5jcmVhdGVkV2l0aCA9IFJlc3RXcml0ZS5idWlsZENyZWF0ZWRXaXRoKGFjdGlvbiwgcmVzb2x2ZWRBdXRoUHJvdmlkZXIpO1xuICByZXR1cm4gdGhpcy5zdG9yYWdlLmNyZWF0ZWRXaXRoO1xufTtcblxuLypcbiAgQXMgd2l0aCB1c2VybmFtZXMsIFBhcnNlIHNob3VsZCBub3QgYWxsb3cgY2FzZSBpbnNlbnNpdGl2ZSBjb2xsaXNpb25zIG9mIGVtYWlsLlxuICB1bmxpa2Ugd2l0aCB1c2VybmFtZXMgKHdoaWNoIGNhbiBoYXZlIGNhc2UgaW5zZW5zaXRpdmUgY29sbGlzaW9ucyBpbiB0aGUgY2FzZSBvZlxuICBhdXRoIGFkYXB0ZXJzKSwgZW1haWxzIHNob3VsZCBuZXZlciBoYXZlIGEgY2FzZSBpbnNlbnNpdGl2ZSBjb2xsaXNpb24uXG5cbiAgVGhpcyBiZWhhdmlvciBjYW4gYmUgZW5mb3JjZWQgdGhyb3VnaCBhIHByb3Blcmx5IGNvbmZpZ3VyZWQgaW5kZXggc2VlOlxuICBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL2NvcmUvaW5kZXgtY2FzZS1pbnNlbnNpdGl2ZS8jY3JlYXRlLWEtY2FzZS1pbnNlbnNpdGl2ZS1pbmRleFxuICB3aGljaCBjb3VsZCBiZSBpbXBsZW1lbnRlZCBpbnN0ZWFkIG9mIHRoaXMgY29kZSBiYXNlZCB2YWxpZGF0aW9uLlxuXG4gIEdpdmVuIHRoYXQgdGhpcyBsb29rdXAgc2hvdWxkIGJlIGEgcmVsYXRpdmVseSBsb3cgdXNlIGNhc2UgYW5kIHRoYXQgdGhlIGNhc2Ugc2Vuc2l0aXZlXG4gIHVuaXF1ZSBpbmRleCB3aWxsIGJlIHVzZWQgYnkgdGhlIGRiIGZvciB0aGUgcXVlcnksIHRoaXMgaXMgYW4gYWRlcXVhdGUgc29sdXRpb24uXG4qL1xuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVFbWFpbCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmRhdGEuZW1haWwgfHwgdGhpcy5kYXRhLmVtYWlsLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFZhbGlkYXRlIGJhc2ljIGVtYWlsIGFkZHJlc3MgZm9ybWF0IGluIGxpbmVhciB0aW1lXG4gIGlmICghdGhpcy5kYXRhLmVtYWlsLm1hdGNoKC9eLlteQFxcblxcclxcdTIwMjhcXHUyMDI5XSpALiskLykpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9FTUFJTF9BRERSRVNTLCAnRW1haWwgYWRkcmVzcyBmb3JtYXQgaXMgaW52YWxpZC4nKVxuICAgICk7XG4gIH1cbiAgLy8gQ2FzZSBpbnNlbnNpdGl2ZSBtYXRjaCwgc2VlIG5vdGUgYWJvdmUgZnVuY3Rpb24uXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5maW5kKFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB7XG4gICAgICAgIGVtYWlsOiB0aGlzLmRhdGEuZW1haWwsXG4gICAgICAgIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICB9LFxuICAgICAgeyBsaW1pdDogMSwgY2FzZUluc2Vuc2l0aXZlOiB0cnVlIH0sXG4gICAgICB7fSxcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgICF0aGlzLmRhdGEuYXV0aERhdGEgfHxcbiAgICAgICAgIU9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoIHx8XG4gICAgICAgIChPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCA9PT0gMSAmJlxuICAgICAgICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSlbMF0gPT09ICdhbm9ueW1vdXMnKVxuICAgICAgKSB7XG4gICAgICAgIC8vIFdlIHVwZGF0ZWQgdGhlIGVtYWlsLCBzZW5kIGEgbmV3IHZhbGlkYXRpb25cbiAgICAgICAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICAgICAgICBjb25zdCByZXF1ZXN0ID0ge1xuICAgICAgICAgIG9yaWdpbmFsOiBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgICBvYmplY3Q6IHVwZGF0ZWRPYmplY3QsXG4gICAgICAgICAgbWFzdGVyOiB0aGlzLmF1dGguaXNNYXN0ZXIsXG4gICAgICAgICAgaXA6IHRoaXMuY29uZmlnLmlwLFxuICAgICAgICAgIGluc3RhbGxhdGlvbklkOiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgY3JlYXRlZFdpdGg6IHRoaXMuZ2V0Q3JlYXRlZFdpdGgoKSxcbiAgICAgICAgfTtcbiAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNldEVtYWlsVmVyaWZ5VG9rZW4odGhpcy5kYXRhLCByZXF1ZXN0LCB0aGlzLnN0b3JhZ2UpO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSkgeyByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7IH1cbiAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMoKS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkoKTtcbiAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzID0gZnVuY3Rpb24gKCkge1xuICAvLyBjaGVjayBpZiB0aGUgcGFzc3dvcmQgY29uZm9ybXMgdG8gdGhlIGRlZmluZWQgcGFzc3dvcmQgcG9saWN5IGlmIGNvbmZpZ3VyZWRcbiAgLy8gSWYgd2Ugc3BlY2lmaWVkIGEgY3VzdG9tIGVycm9yIGluIG91ciBjb25maWd1cmF0aW9uIHVzZSBpdC5cbiAgLy8gRXhhbXBsZTogXCJQYXNzd29yZHMgbXVzdCBpbmNsdWRlIGEgQ2FwaXRhbCBMZXR0ZXIsIExvd2VyY2FzZSBMZXR0ZXIsIGFuZCBhIG51bWJlci5cIlxuICAvL1xuICAvLyBUaGlzIGlzIGVzcGVjaWFsbHkgdXNlZnVsIG9uIHRoZSBnZW5lcmljIFwicGFzc3dvcmQgcmVzZXRcIiBwYWdlLFxuICAvLyBhcyBpdCBhbGxvd3MgdGhlIHByb2dyYW1tZXIgdG8gY29tbXVuaWNhdGUgc3BlY2lmaWMgcmVxdWlyZW1lbnRzIGluc3RlYWQgb2Y6XG4gIC8vIGEuIG1ha2luZyB0aGUgdXNlciBndWVzcyB3aGF0cyB3cm9uZ1xuICAvLyBiLiBtYWtpbmcgYSBjdXN0b20gcGFzc3dvcmQgcmVzZXQgcGFnZSB0aGF0IHNob3dzIHRoZSByZXF1aXJlbWVudHNcbiAgY29uc3QgcG9saWN5RXJyb3IgPSB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0aW9uRXJyb3JcbiAgICA/IHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRpb25FcnJvclxuICAgIDogJ1Bhc3N3b3JkIGRvZXMgbm90IG1lZXQgdGhlIFBhc3N3b3JkIFBvbGljeSByZXF1aXJlbWVudHMuJztcbiAgY29uc3QgY29udGFpbnNVc2VybmFtZUVycm9yID0gJ1Bhc3N3b3JkIGNhbm5vdCBjb250YWluIHlvdXIgdXNlcm5hbWUuJztcblxuICAvLyBjaGVjayB3aGV0aGVyIHRoZSBwYXNzd29yZCBtZWV0cyB0aGUgcGFzc3dvcmQgc3RyZW5ndGggcmVxdWlyZW1lbnRzXG4gIGlmIChcbiAgICAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kucGF0dGVyblZhbGlkYXRvciAmJlxuICAgICAgIXRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnBhdHRlcm5WYWxpZGF0b3IodGhpcy5kYXRhLnBhc3N3b3JkKSkgfHxcbiAgICAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sgJiZcbiAgICAgICF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayh0aGlzLmRhdGEucGFzc3dvcmQpKVxuICApIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIHBvbGljeUVycm9yKSk7XG4gIH1cblxuICAvLyBjaGVjayB3aGV0aGVyIHBhc3N3b3JkIGNvbnRhaW4gdXNlcm5hbWVcbiAgaWYgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LmRvTm90QWxsb3dVc2VybmFtZSA9PT0gdHJ1ZSkge1xuICAgIGlmICh0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICAgIC8vIHVzZXJuYW1lIGlzIG5vdCBwYXNzZWQgZHVyaW5nIHBhc3N3b3JkIHJlc2V0XG4gICAgICBpZiAodGhpcy5kYXRhLnBhc3N3b3JkLmluZGV4T2YodGhpcy5kYXRhLnVzZXJuYW1lKSA+PSAwKVxuICAgICAgeyByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIGNvbnRhaW5zVXNlcm5hbWVFcnJvcikpOyB9XG4gICAgfSBlbHNlIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgICAvLyByZXRyaWV2ZSB0aGUgVXNlciBvYmplY3QgdXNpbmcgdGhlIFVSTCBvYmplY3QgSUQgZHVyaW5nIHBhc3N3b3JkIHJlc2V0XG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCB7IG9iamVjdElkOiB0aGlzLnF1ZXJ5Lm9iamVjdElkIH0pLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQuaW5kZXhPZihyZXN1bHRzWzBdLnVzZXJuYW1lKSA+PSAwKVxuICAgICAgICB7IHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUiwgY29udGFpbnNVc2VybmFtZUVycm9yKVxuICAgICAgICApOyB9XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBpcyByZXBlYXRpbmcgZnJvbSBzcGVjaWZpZWQgaGlzdG9yeVxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkpIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5maW5kKFxuICAgICAgICAnX1VzZXInLFxuICAgICAgICB7IG9iamVjdElkOiB0aGlzLnF1ZXJ5Lm9iamVjdElkIH0sXG4gICAgICAgIHsga2V5czogWydfcGFzc3dvcmRfaGlzdG9yeScsICdfaGFzaGVkX3Bhc3N3b3JkJ10gfSxcbiAgICAgICAgQXV0aC5tYWludGVuYW5jZSh0aGlzLmNvbmZpZylcbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggIT0gMSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZC4nKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB1c2VyID0gcmVzdWx0c1swXTtcbiAgICAgICAgbGV0IG9sZFBhc3N3b3JkcyA9IFtdO1xuICAgICAgICBpZiAodXNlci5fcGFzc3dvcmRfaGlzdG9yeSlcbiAgICAgICAgeyBvbGRQYXNzd29yZHMgPSBfLnRha2UoXG4gICAgICAgICAgdXNlci5fcGFzc3dvcmRfaGlzdG9yeSxcbiAgICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgLSAxXG4gICAgICAgICk7IH1cbiAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgIGNvbnN0IG5ld1Bhc3N3b3JkID0gdGhpcy5kYXRhLnBhc3N3b3JkO1xuICAgICAgICAvLyBjb21wYXJlIHRoZSBuZXcgcGFzc3dvcmQgaGFzaCB3aXRoIGFsbCBvbGQgcGFzc3dvcmQgaGFzaGVzXG4gICAgICAgIGNvbnN0IHByb21pc2VzID0gb2xkUGFzc3dvcmRzLm1hcChmdW5jdGlvbiAoaGFzaCkge1xuICAgICAgICAgIHJldHVybiBwYXNzd29yZENyeXB0by5jb21wYXJlKG5ld1Bhc3N3b3JkLCBoYXNoKS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0KVxuICAgICAgICAgICAgLy8gcmVqZWN0IGlmIHRoZXJlIGlzIGEgbWF0Y2hcbiAgICAgICAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KCdSRVBFQVRfUEFTU1dPUkQnKTsgfVxuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgLy8gd2FpdCBmb3IgYWxsIGNvbXBhcmlzb25zIHRvIGNvbXBsZXRlXG4gICAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcylcbiAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuY2F0Y2goZXJyID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIgPT09ICdSRVBFQVRfUEFTU1dPUkQnKVxuICAgICAgICAgICAgLy8gYSBtYXRjaCB3YXMgZm91bmRcbiAgICAgICAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUixcbiAgICAgICAgICAgICAgICBgTmV3IHBhc3N3b3JkIHNob3VsZCBub3QgYmUgdGhlIHNhbWUgYXMgbGFzdCAke3RoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeX0gcGFzc3dvcmRzLmBcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTsgfVxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERvbid0IGdlbmVyYXRlIHNlc3Npb24gZm9yIHVwZGF0aW5nIHVzZXIgKHRoaXMucXVlcnkgaXMgc2V0KSB1bmxlc3MgYXV0aERhdGEgZXhpc3RzXG4gIGlmICh0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gRG9uJ3QgZ2VuZXJhdGUgbmV3IHNlc3Npb25Ub2tlbiBpZiBsaW5raW5nIHZpYSBzZXNzaW9uVG9rZW5cbiAgaWYgKHRoaXMuYXV0aC51c2VyICYmIHRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBJZiBzaWduLXVwIGNhbGxcbiAgaWYgKCF0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyKSB7XG4gICAgLy8gQ3JlYXRlIHJlcXVlc3Qgb2JqZWN0IGZvciB2ZXJpZmljYXRpb24gZnVuY3Rpb25zXG4gICAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICBvcmlnaW5hbDogb3JpZ2luYWxPYmplY3QsXG4gICAgICBvYmplY3Q6IHVwZGF0ZWRPYmplY3QsXG4gICAgICBtYXN0ZXI6IHRoaXMuYXV0aC5pc01hc3RlcixcbiAgICAgIGlwOiB0aGlzLmNvbmZpZy5pcCxcbiAgICAgIGluc3RhbGxhdGlvbklkOiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gICAgICBjcmVhdGVkV2l0aDogdGhpcy5nZXRDcmVhdGVkV2l0aCgpLFxuICAgIH07XG4gICAgLy8gR2V0IHZlcmlmaWNhdGlvbiBjb25kaXRpb25zIHdoaWNoIGNhbiBiZSBib29sZWFucyBvciBmdW5jdGlvbnM7IHRoZSBwdXJwb3NlIG9mIHRoaXMgYXN5bmMvYXdhaXRcbiAgICAvLyBzdHJ1Y3R1cmUgaXMgdG8gYXZvaWQgdW5uZWNlc3NhcmlseSBleGVjdXRpbmcgc3Vic2VxdWVudCBmdW5jdGlvbnMgaWYgcHJldmlvdXMgb25lcyBmYWlsIGluIHRoZVxuICAgIC8vIGNvbmRpdGlvbmFsIHN0YXRlbWVudCBiZWxvdywgYXMgYSBkZXZlbG9wZXIgbWF5IGRlY2lkZSB0byBleGVjdXRlIGV4cGVuc2l2ZSBvcGVyYXRpb25zIGluIHRoZW1cbiAgICBjb25zdCB2ZXJpZnlVc2VyRW1haWxzID0gYXN5bmMgKCkgPT4gdGhpcy5jb25maWcudmVyaWZ5VXNlckVtYWlscyA9PT0gdHJ1ZSB8fCAodHlwZW9mIHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHMgPT09ICdmdW5jdGlvbicgJiYgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHMocmVxdWVzdCkpID09PSB0cnVlKTtcbiAgICBjb25zdCBwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID0gYXN5bmMgKCkgPT4gdGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCA9PT0gdHJ1ZSB8fCAodHlwZW9mIHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPT09ICdmdW5jdGlvbicgJiYgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwocmVxdWVzdCkpID09PSB0cnVlKTtcbiAgICAvLyBJZiB2ZXJpZmljYXRpb24gaXMgcmVxdWlyZWRcbiAgICBpZiAoYXdhaXQgdmVyaWZ5VXNlckVtYWlscygpICYmIGF3YWl0IHByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwoKSkge1xuICAgICAgdGhpcy5zdG9yYWdlLnJlamVjdFNpZ251cCA9IHRydWU7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG4gIHJldHVybiB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbigpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jcmVhdGVTZXNzaW9uVG9rZW4gPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIC8vIGNsb3VkIGluc3RhbGxhdGlvbklkIGZyb20gQ2xvdWQgQ29kZSxcbiAgLy8gbmV2ZXIgY3JlYXRlIHNlc3Npb24gdG9rZW5zIGZyb20gdGhlcmUuXG4gIGlmICh0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQgJiYgdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkID09PSAnY2xvdWQnKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgPT0gbnVsbCAmJiB0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICB0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyID0gT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5qb2luKCcsJyk7XG4gICAgLy8gSW52YWxpZGF0ZSBjYWNoZWQgY3JlYXRlZFdpdGggc2luY2UgYXV0aFByb3ZpZGVyIHdhcyBqdXN0IHJlc29sdmVkXG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZS5jcmVhdGVkV2l0aDtcbiAgfVxuXG4gIGNvbnN0IGNyZWF0ZWRXaXRoID0gdGhpcy5nZXRDcmVhdGVkV2l0aCgpO1xuICBjb25zdCB7IHNlc3Npb25EYXRhLCBjcmVhdGVTZXNzaW9uIH0gPSBSZXN0V3JpdGUuY3JlYXRlU2Vzc2lvbih0aGlzLmNvbmZpZywge1xuICAgIHVzZXJJZDogdGhpcy5vYmplY3RJZCgpLFxuICAgIGNyZWF0ZWRXaXRoLFxuICAgIGluc3RhbGxhdGlvbklkOiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gIH0pO1xuXG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLnNlc3Npb25Ub2tlbiA9IHNlc3Npb25EYXRhLnNlc3Npb25Ub2tlbjtcbiAgICB0aGlzLnN0b3JhZ2UuaXNzdWVkU2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcbn07XG5cblJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uID0gZnVuY3Rpb24gKFxuICBjb25maWcsXG4gIHsgdXNlcklkLCBjcmVhdGVkV2l0aCwgaW5zdGFsbGF0aW9uSWQsIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSB9XG4pIHtcbiAgY29uc3QgdG9rZW4gPSAncjonICsgY3J5cHRvVXRpbHMubmV3VG9rZW4oKTtcbiAgY29uc3QgZXhwaXJlc0F0ID0gY29uZmlnLmdlbmVyYXRlU2Vzc2lvbkV4cGlyZXNBdCgpO1xuICBjb25zdCBzZXNzaW9uRGF0YSA9IHtcbiAgICBzZXNzaW9uVG9rZW46IHRva2VuLFxuICAgIHVzZXI6IHtcbiAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgb2JqZWN0SWQ6IHVzZXJJZCxcbiAgICB9LFxuICAgIGNyZWF0ZWRXaXRoLFxuICAgIGV4cGlyZXNBdDogUGFyc2UuX2VuY29kZShleHBpcmVzQXQpLFxuICB9O1xuXG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIHNlc3Npb25EYXRhLmluc3RhbGxhdGlvbklkID0gaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBPYmplY3QuYXNzaWduKHNlc3Npb25EYXRhLCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEpO1xuXG4gIHJldHVybiB7XG4gICAgc2Vzc2lvbkRhdGEsXG4gICAgY3JlYXRlU2Vzc2lvbjogKCkgPT5cbiAgICAgIG5ldyBSZXN0V3JpdGUoY29uZmlnLCBBdXRoLm1hc3Rlcihjb25maWcpLCAnX1Nlc3Npb24nLCBudWxsLCBzZXNzaW9uRGF0YSkuZXhlY3V0ZSgpLFxuICB9O1xufTtcblxuLy8gRGVsZXRlIGVtYWlsIHJlc2V0IHRva2VucyBpZiB1c2VyIGlzIGNoYW5naW5nIHBhc3N3b3JkIG9yIGVtYWlsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZWxldGVFbWFpbFJlc2V0VG9rZW5JZk5lZWRlZCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IHRoaXMucXVlcnkgPT09IG51bGwpIHtcbiAgICAvLyBudWxsIHF1ZXJ5IG1lYW5zIGNyZWF0ZVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgncGFzc3dvcmQnIGluIHRoaXMuZGF0YSB8fCAnZW1haWwnIGluIHRoaXMuZGF0YSkge1xuICAgIGNvbnN0IGFkZE9wcyA9IHtcbiAgICAgIF9wZXJpc2hhYmxlX3Rva2VuOiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgICBfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0OiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgfTtcbiAgICB0aGlzLmRhdGEgPSBPYmplY3QuYXNzaWduKHRoaXMuZGF0YSwgYWRkT3BzKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zID0gZnVuY3Rpb24gKCkge1xuICAvLyBTa2lwIGlmIHRoZSByZXNwb25zZSBpcyBhbHJlYWR5IHNldCwgbWF0Y2hpbmcgdGhlIG90aGVyIHdyaXRlLXBpcGVsaW5lIHN0ZXBzXG4gIC8vIChydW5EYXRhYmFzZU9wZXJhdGlvbiwgcnVuQWZ0ZXJTYXZlVHJpZ2dlcikuIEEgbm9uLW1hc3RlciBQT1NUIC9jbGFzc2VzL19TZXNzaW9uXG4gIC8vIGNyZWF0ZSBoYXMgaGFuZGxlU2Vzc2lvbigpIHNldCB0aGlzLnJlc3BvbnNlIGJlZm9yZSB0aGlzIHJ1bnMsIHNvIHRoaXMgZ3VhcmRcbiAgLy8gcHJldmVudHMgdGhlIGRlZHVwIGRlbGV0ZSBmcm9tIGFjdGluZyBvbiB0aGUgY2xpZW50LXN1cHBsaWVkIGB1c2VyYC9gaW5zdGFsbGF0aW9uSWRgXG4gIC8vIHJhdGhlciB0aGFuIG9uIHRoZSBzZXJ2ZXItZ2VuZXJhdGVkIHNlc3Npb24gZGF0YS5cbiAgaWYgKHRoaXMucmVzcG9uc2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gT25seSBmb3IgX1Nlc3Npb24sIGFuZCBhdCBjcmVhdGlvbiB0aW1lXG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPSAnX1Nlc3Npb24nIHx8IHRoaXMucXVlcnkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gRGVzdHJveSB0aGUgc2Vzc2lvbnMgaW4gJ0JhY2tncm91bmQnXG4gIGNvbnN0IHsgdXNlciwgaW5zdGFsbGF0aW9uSWQsIHNlc3Npb25Ub2tlbiB9ID0gdGhpcy5kYXRhO1xuICBpZiAoIXVzZXIgfHwgIWluc3RhbGxhdGlvbklkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghdXNlci5vYmplY3RJZCkge1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveShcbiAgICAnX1Nlc3Npb24nLFxuICAgIHtcbiAgICAgIHVzZXIsXG4gICAgICBpbnN0YWxsYXRpb25JZCxcbiAgICAgIHNlc3Npb25Ub2tlbjogeyAkbmU6IHNlc3Npb25Ub2tlbiB9LFxuICAgIH0sXG4gICAge30sXG4gICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgKS5jYXRjaChlID0+IHtcbiAgICBpZiAoZS5jb2RlICE9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgfSk7XG59O1xuXG4vLyBIYW5kbGVzIGFueSBmb2xsb3d1cCBsb2dpY1xuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVGb2xsb3d1cCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSAmJiB0aGlzLmNvbmZpZy5yZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0KSB7XG4gICAgdmFyIHNlc3Npb25RdWVyeSA9IHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBkZWxldGUgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ107XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuZGVzdHJveSgnX1Nlc3Npb24nLCBzZXNzaW9uUXVlcnkpXG4gICAgICAudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnZ2VuZXJhdGVOZXdTZXNzaW9uJ107XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuKCkudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnc2VuZFZlcmlmaWNhdGlvbkVtYWlsJ107XG4gICAgLy8gRmlyZSBhbmQgZm9yZ2V0IVxuICAgIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNlbmRWZXJpZmljYXRpb25FbWFpbCh0aGlzLmRhdGEsIHsgYXV0aDogdGhpcy5hdXRoIH0pO1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcyk7XG4gIH1cbn07XG5cbi8vIEhhbmRsZXMgdGhlIF9TZXNzaW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gX1Nlc3Npb24gb2JqZWN0LlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVTZXNzaW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLmNsYXNzTmFtZSAhPT0gJ19TZXNzaW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLnVzZXIgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLCAnU2Vzc2lvbiB0b2tlbiByZXF1aXJlZC4nKTtcbiAgfVxuXG4gIC8vIFRPRE86IFZlcmlmeSBwcm9wZXIgZXJyb3IgdG8gdGhyb3dcbiAgaWYgKCdBQ0wnIGluIHRoaXMuZGF0YSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnQ2Fubm90IHNldCAnICsgJ0FDTCBvbiBhIFNlc3Npb24uJyk7XG4gIH1cblxuICBpZiAodGhpcy5xdWVyeSkge1xuICAgIGlmICgndXNlcicgaW4gdGhpcy5kYXRhICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgdGhpcy5kYXRhLnVzZXI/Lm9iamVjdElkICE9PSB0aGlzLmF1dGgudXNlci5pZCkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdJbnZhbGlkIGtleSBuYW1lOiB1c2VyJyk7XG4gICAgfSBlbHNlIGlmICgnaW5zdGFsbGF0aW9uSWQnIGluIHRoaXMuZGF0YSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdJbnZhbGlkIGtleSBuYW1lOiBpbnN0YWxsYXRpb25JZCcpO1xuICAgIH0gZWxzZSBpZiAoJ3Nlc3Npb25Ub2tlbicgaW4gdGhpcy5kYXRhKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0ludmFsaWQga2V5IG5hbWU6IHNlc3Npb25Ub2tlbicpO1xuICAgIH0gZWxzZSBpZiAoJ2V4cGlyZXNBdCcgaW4gdGhpcy5kYXRhICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0ludmFsaWQga2V5IG5hbWU6IGV4cGlyZXNBdCcpO1xuICAgIH0gZWxzZSBpZiAoJ2NyZWF0ZWRXaXRoJyBpbiB0aGlzLmRhdGEgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnSW52YWxpZCBrZXkgbmFtZTogY3JlYXRlZFdpdGgnKTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICAgIHRoaXMucXVlcnkgPSB7XG4gICAgICAgICRhbmQ6IFtcbiAgICAgICAgICB0aGlzLnF1ZXJ5LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHVzZXI6IHtcbiAgICAgICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgICAgICAgb2JqZWN0SWQ6IHRoaXMuYXV0aC51c2VyLmlkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICBpZiAoIXRoaXMucXVlcnkgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICBjb25zdCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEgPSB7fTtcbiAgICBmb3IgKHZhciBrZXkgaW4gdGhpcy5kYXRhKSB7XG4gICAgICBpZiAoa2V5ID09PSAnb2JqZWN0SWQnIHx8IGtleSA9PT0gJ3VzZXInIHx8IGtleSA9PT0gJ3Nlc3Npb25Ub2tlbicgfHwga2V5ID09PSAnZXhwaXJlc0F0JyB8fCBrZXkgPT09ICdjcmVhdGVkV2l0aCcpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBhZGRpdGlvbmFsU2Vzc2lvbkRhdGFba2V5XSA9IHRoaXMuZGF0YVtrZXldO1xuICAgIH1cblxuICAgIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IFJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uKHRoaXMuY29uZmlnLCB7XG4gICAgICB1c2VySWQ6IHRoaXMuYXV0aC51c2VyLmlkLFxuICAgICAgY3JlYXRlZFdpdGg6IHtcbiAgICAgICAgYWN0aW9uOiAnY3JlYXRlJyxcbiAgICAgIH0sXG4gICAgICBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEsXG4gICAgfSk7XG5cbiAgICAvLyBFbmZvcmNlIHRoZSBjYWxsZXIncyBjbGFzcy1sZXZlbCBwZXJtaXNzaW9ucyBhbmQgc2NoZW1hIGJlZm9yZSB0aGUgbWFzdGVyIHdyaXRlXG4gICAgY29uc3QgdmFsaWRhdGVkID0gdGhpcy52YWxpZGF0ZVdyaXRlUGVybWlzc2lvbigpLnRoZW4oKCkgPT4gdGhpcy52YWxpZGF0ZVNjaGVtYSgpKTtcbiAgICByZXR1cm4gdmFsaWRhdGVkLnRoZW4oKCkgPT4gY3JlYXRlU2Vzc2lvbigpKS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKCFyZXN1bHRzLnJlc3BvbnNlKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsICdFcnJvciBjcmVhdGluZyBzZXNzaW9uLicpO1xuICAgICAgfVxuICAgICAgc2Vzc2lvbkRhdGFbJ29iamVjdElkJ10gPSByZXN1bHRzLnJlc3BvbnNlWydvYmplY3RJZCddO1xuICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgc3RhdHVzOiAyMDEsXG4gICAgICAgIGxvY2F0aW9uOiByZXN1bHRzLmxvY2F0aW9uLFxuICAgICAgICByZXNwb25zZTogc2Vzc2lvbkRhdGEsXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfSW5zdGFsbGF0aW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gaW5zdGFsbGF0aW9uIG9iamVjdC5cbi8vIElmIGFuIGluc3RhbGxhdGlvbiBpcyBmb3VuZCwgdGhpcyBjYW4gbXV0YXRlIHRoaXMucXVlcnkgYW5kIHR1cm4gYSBjcmVhdGVcbi8vIGludG8gYW4gdXBkYXRlLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVJbnN0YWxsYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMuY2xhc3NOYW1lICE9PSAnX0luc3RhbGxhdGlvbicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgZGVkdXBsaWNhdGlvbiBiZWxvdyBlbWJlZHMgdGhlc2UgY2xpZW50LXN1cHBsaWVkIHZhbHVlcyBkaXJlY3RseSBpbnRvIGRhdGFiYXNlXG4gIC8vIHF1ZXJpZXMgdGhhdCBkZWxldGUgb3IgdXBkYXRlIHJvd3Mgd2l0aCBtYXN0ZXIgcHJpdmlsZWdlcywgYW5kIGl0IHJ1bnMgYmVmb3JlXG4gIC8vIGB2YWxpZGF0ZVNjaGVtYWAsIHNvIHRoZWlyIHR5cGVzIG11c3QgYmUgZW5mb3JjZWQgaGVyZTogYSBub24tc3RyaW5nIHZhbHVlIHdvdWxkXG4gIC8vIG90aGVyd2lzZSByZWFjaCB0aGUgZGF0YWJhc2UgYXMgYSBxdWVyeSBjb25zdHJhaW50IChzdWNoIGFzIGFuIG9wZXJhdG9yIG9iamVjdFxuICAvLyBge1wiJG5lXCI6IG51bGx9YCkgbWF0Y2hpbmcgcm93cyB0aGUgY2xpZW50IG5ldmVyIGlkZW50aWZpZWQsIGluc3RlYWQgb2YgYXMgYSBsaXRlcmFsXG4gIC8vIHZhbHVlIHRvIG1hdGNoIGFnYWluc3QuIFRoZSBzY2hlbWEgZGVjbGFyZXMgYWxsIHRocmVlIGFzIGBTdHJpbmdgLCBidXQgdGhhdCBjaGVja1xuICAvLyBjYW5ub3QgYmUgcmV1c2VkIGhlcmU7IGl0IHJ1bnMgbGF0ZXIgaW4gdGhlIHdyaXRlIHBpcGVsaW5lIGFuZCBtb3ZpbmcgaXQgZWFybGllclxuICAvLyB3b3VsZCBtdXRhdGUgdGhlIHNjaGVtYSBiZWZvcmUgdGhlIHBlcm1pc3Npb24gY2hlY2suIFRoZSBmaWVsZCBsaXN0IGlzIGEgcHJvcGVydHkgb2ZcbiAgLy8gdGhpcyBmdW5jdGlvbiByYXRoZXIgdGhhbiBvZiB0aGUgc2NoZW1hOiBpdCBpcyB0aGUgc2V0IG9mIHZhbHVlcyBzcGxpY2VkIGludG8gdGhlXG4gIC8vIGRlZHVwbGljYXRpb24gcXVlcmllcyBiZWxvdy5cbiAgZm9yIChjb25zdCBmaWVsZE5hbWUgb2YgWydkZXZpY2VUb2tlbicsICdpbnN0YWxsYXRpb25JZCcsICdhcHBJZGVudGlmaWVyJ10pIHtcbiAgICBjb25zdCB2YWx1ZSA9IHRoaXMuZGF0YVtmaWVsZE5hbWVdO1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsIHx8IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoZmllbGROYW1lID09PSAnYXBwSWRlbnRpZmllcicgJiYgdmFsdWUuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBhY3R1YWxUeXBlID0gQXJyYXkuaXNBcnJheSh2YWx1ZSlcbiAgICAgID8gJ0FycmF5J1xuICAgICAgOiBgJHt0eXBlb2YgdmFsdWV9YC5yZXBsYWNlKC9eLi8sIGNoYXJhY3RlciA9PiBjaGFyYWN0ZXIudG9VcHBlckNhc2UoKSk7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5DT1JSRUNUX1RZUEUsXG4gICAgICBgc2NoZW1hIG1pc21hdGNoIGZvciBfSW5zdGFsbGF0aW9uLiR7ZmllbGROYW1lfTsgZXhwZWN0ZWQgU3RyaW5nIGJ1dCBnb3QgJHthY3R1YWxUeXBlfWBcbiAgICApO1xuICB9XG5cbiAgaWYgKFxuICAgICF0aGlzLnF1ZXJ5ICYmXG4gICAgIXRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAhdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIDEzNSxcbiAgICAgICdhdCBsZWFzdCBvbmUgSUQgZmllbGQgKGRldmljZVRva2VuLCBpbnN0YWxsYXRpb25JZCkgJyArICdtdXN0IGJlIHNwZWNpZmllZCBpbiB0aGlzIG9wZXJhdGlvbidcbiAgICApO1xuICB9XG5cbiAgLy8gSWYgdGhlIGRldmljZSB0b2tlbiBpcyA2NCBjaGFyYWN0ZXJzIGxvbmcsIHdlIGFzc3VtZSBpdCBpcyBmb3IgaU9TXG4gIC8vIGFuZCBsb3dlcmNhc2UgaXQuXG4gIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiYgdGhpcy5kYXRhLmRldmljZVRva2VuLmxlbmd0aCA9PSA2NCkge1xuICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiA9IHRoaXMuZGF0YS5kZXZpY2VUb2tlbi50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgLy8gV2UgbG93ZXJjYXNlIHRoZSBpbnN0YWxsYXRpb25JZCBpZiBwcmVzZW50XG4gIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQudG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIGxldCBpbnN0YWxsYXRpb25JZCA9IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZDtcblxuICAvLyBDcmVhdGUgb25seTogdGhlIHJlcXVlc3QgaW5zdGFsbGF0aW9uIElEIG5hbWVzIHRoZSBjYWxsZXIncyBvd24gaW5zdGFsbGF0aW9uXG4gIGlmICghaW5zdGFsbGF0aW9uSWQgJiYgIXRoaXMucXVlcnkgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICBpbnN0YWxsYXRpb25JZCA9IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuXG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIGluc3RhbGxhdGlvbklkID0gaW5zdGFsbGF0aW9uSWQudG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIC8vIFVwZGF0aW5nIF9JbnN0YWxsYXRpb24gYnV0IG5vdCB1cGRhdGluZyBhbnl0aGluZyBjcml0aWNhbFxuICBpZiAodGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmICFpbnN0YWxsYXRpb25JZCAmJiAhdGhpcy5kYXRhLmRldmljZVR5cGUpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4gIHZhciBpZE1hdGNoOyAvLyBXaWxsIGJlIGEgbWF0Y2ggb24gZWl0aGVyIG9iamVjdElkIG9yIGluc3RhbGxhdGlvbklkXG4gIHZhciBvYmplY3RJZE1hdGNoO1xuICB2YXIgaW5zdGFsbGF0aW9uSWRNYXRjaDtcbiAgdmFyIGRldmljZVRva2VuTWF0Y2hlcyA9IFtdO1xuXG4gIC8vIEluc3RlYWQgb2YgaXNzdWluZyAzIHJlYWRzLCBsZXQncyBkbyBpdCB3aXRoIG9uZSBPUi5cbiAgY29uc3Qgb3JRdWVyaWVzID0gW107XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBvYmplY3RJZDogdGhpcy5xdWVyeS5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBpbnN0YWxsYXRpb25JZDogaW5zdGFsbGF0aW9uSWQsXG4gICAgfSk7XG4gIH1cbiAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgIG9yUXVlcmllcy5wdXNoKHsgZGV2aWNlVG9rZW46IHRoaXMuZGF0YS5kZXZpY2VUb2tlbiB9KTtcbiAgfVxuXG4gIGlmIChvclF1ZXJpZXMubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBwcm9taXNlID0gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAnX0luc3RhbGxhdGlvbicsXG4gICAgICAgIHtcbiAgICAgICAgICAkb3I6IG9yUXVlcmllcyxcbiAgICAgICAgfSxcbiAgICAgICAge31cbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMuZm9yRWFjaChyZXN1bHQgPT4ge1xuICAgICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIHJlc3VsdC5vYmplY3RJZCA9PSB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgb2JqZWN0SWRNYXRjaCA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVzdWx0Lmluc3RhbGxhdGlvbklkID09IGluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgICAgaW5zdGFsbGF0aW9uSWRNYXRjaCA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVzdWx0LmRldmljZVRva2VuID09IHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgICAgICAgIGRldmljZVRva2VuTWF0Y2hlcy5wdXNoKHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICAvLyBTYW5pdHkgY2hlY2tzIHdoZW4gcnVubmluZyBhIHF1ZXJ5XG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgIGlmICghb2JqZWN0SWRNYXRjaCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZCBmb3IgdXBkYXRlLicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICBvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICE9PSBvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsICdpbnN0YWxsYXRpb25JZCBtYXkgbm90IGJlIGNoYW5nZWQgaW4gdGhpcyAnICsgJ29wZXJhdGlvbicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICBvYmplY3RJZE1hdGNoLmRldmljZVRva2VuICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICE9PSBvYmplY3RJZE1hdGNoLmRldmljZVRva2VuICYmXG4gICAgICAgICAgIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgICFvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsICdkZXZpY2VUb2tlbiBtYXkgbm90IGJlIGNoYW5nZWQgaW4gdGhpcyAnICsgJ29wZXJhdGlvbicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgIT09IG9iamVjdElkTWF0Y2guZGV2aWNlVHlwZVxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoMTM2LCAnZGV2aWNlVHlwZSBtYXkgbm90IGJlIGNoYW5nZWQgaW4gdGhpcyAnICsgJ29wZXJhdGlvbicpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQgJiYgb2JqZWN0SWRNYXRjaCkge1xuICAgICAgICBpZE1hdGNoID0gb2JqZWN0SWRNYXRjaDtcbiAgICAgIH1cblxuICAgICAgaWYgKGluc3RhbGxhdGlvbklkICYmIGluc3RhbGxhdGlvbklkTWF0Y2gpIHtcbiAgICAgICAgaWRNYXRjaCA9IGluc3RhbGxhdGlvbklkTWF0Y2g7XG4gICAgICB9XG4gICAgICAvLyBuZWVkIHRvIHNwZWNpZnkgZGV2aWNlVHlwZSBvbmx5IGlmIGl0J3MgbmV3XG4gICAgICBpZiAoIXRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5kZXZpY2VUeXBlICYmICFpZE1hdGNoKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzUsICdkZXZpY2VUeXBlIG11c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJyk7XG4gICAgICB9XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICBpZiAoIWlkTWF0Y2gpIHtcbiAgICAgICAgaWYgKCFkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIGRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGggPT0gMSAmJlxuICAgICAgICAgICghZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydpbnN0YWxsYXRpb25JZCddIHx8ICFpbnN0YWxsYXRpb25JZClcbiAgICAgICAgKSB7XG4gICAgICAgICAgLy8gU2luZ2xlIG1hdGNoIG9uIGRldmljZSB0b2tlbiBidXQgbm9uZSBvbiBpbnN0YWxsYXRpb25JZCwgYW5kIGVpdGhlclxuICAgICAgICAgIC8vIHRoZSBwYXNzZWQgb2JqZWN0IG9yIHRoZSBtYXRjaCBpcyBtaXNzaW5nIGFuIGluc3RhbGxhdGlvbklkLCBzbyB3ZVxuICAgICAgICAgIC8vIGNhbiBqdXN0IHJldHVybiB0aGUgbWF0Y2guXG4gICAgICAgICAgcmV0dXJuIGRldmljZVRva2VuTWF0Y2hlc1swXVsnb2JqZWN0SWQnXTtcbiAgICAgICAgfSBlbHNlIGlmICghdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgMTMyLFxuICAgICAgICAgICAgJ011c3Qgc3BlY2lmeSBpbnN0YWxsYXRpb25JZCB3aGVuIGRldmljZVRva2VuICcgK1xuICAgICAgICAgICAgICAnbWF0Y2hlcyBtdWx0aXBsZSBJbnN0YWxsYXRpb24gb2JqZWN0cydcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIE11bHRpcGxlIGRldmljZSB0b2tlbiBtYXRjaGVzIGFuZCB3ZSBzcGVjaWZpZWQgYW4gaW5zdGFsbGF0aW9uIElELFxuICAgICAgICAgIC8vIG9yIGEgc2luZ2xlIG1hdGNoIHdoZXJlIGJvdGggdGhlIHBhc3NlZCBhbmQgbWF0Y2hpbmcgb2JqZWN0cyBoYXZlXG4gICAgICAgICAgLy8gYW4gaW5zdGFsbGF0aW9uIElELiBDbGVhbiBvdXQgb3RoZXIgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoIHRoZVxuICAgICAgICAgIC8vIGRldmljZVRva2VuLCBhbmQgcmV0dXJuIG5pbCB0byBzaWduYWwgdGhhdCBhIG5ldyBvYmplY3Qgc2hvdWxkIGJlXG4gICAgICAgICAgLy8gY3JlYXRlZC5cbiAgICAgICAgICBjb25zdCBkZWxRdWVyeSA9IHtcbiAgICAgICAgICAgIGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4sXG4gICAgICAgICAgICBpbnN0YWxsYXRpb25JZDoge1xuICAgICAgICAgICAgICAkbmU6IGluc3RhbGxhdGlvbklkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9O1xuICAgICAgICAgIGlmICh0aGlzLmRhdGEuYXBwSWRlbnRpZmllcikge1xuICAgICAgICAgICAgLy8gQSBgRGVsZXRlYCBvcGVyYXRpb24gaXMgYXBwbGllZCBvbmx5IGFmdGVyIHRoZSBkZWR1cGxpY2F0aW9uIHJ1bnMsIGFuZCBub1xuICAgICAgICAgICAgLy8gaW5zdGFsbGF0aW9uIG1hdGNoZWQgaGVyZSB0byB0YWtlIGEgc2NvcGUgZnJvbS4gU2tpcCB0aGUgY2xlYW51cCByYXRoZXIgdGhhblxuICAgICAgICAgICAgLy8gcnVuIGl0IHVuc2NvcGVkIGFjcm9zcyBldmVyeSBhcHBsaWNhdGlvbiwgb3IgcXVlcnkgb24gdGhlIG9wZXJhdGlvbiBpdHNlbGYuXG4gICAgICAgICAgICBpZiAodHlwZW9mIHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBkZWxRdWVyeVsnYXBwSWRlbnRpZmllciddID0gdGhpcy5kYXRhLmFwcElkZW50aWZpZXI7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IGluc3RhbGxhdGlvbk9wdHMgPSB0aGlzLmNvbmZpZy5pbnN0YWxsYXRpb24gfHwge307XG4gICAgICAgICAgcmV0dXJuIEluc3RhbGxhdGlvbkRlZHVwLnJlbW92ZUNvbmZsaWN0aW5nRGV2aWNlVG9rZW4oe1xuICAgICAgICAgICAgZGF0YWJhc2U6IHRoaXMuY29uZmlnLmRhdGFiYXNlLFxuICAgICAgICAgICAgcXVlcnk6IGRlbFF1ZXJ5LFxuICAgICAgICAgICAgYWN0aW9uOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uIHx8ICdkZWxldGUnLFxuICAgICAgICAgICAgZW5mb3JjZUF1dGg6IGluc3RhbGxhdGlvbk9wdHMuZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb25FbmZvcmNlQXV0aCA9PT0gdHJ1ZSxcbiAgICAgICAgICAgIHJ1bk9wdGlvbnM6IHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICAgIHZhbGlkU2NoZW1hQ29udHJvbGxlcjogdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoID09IDEgJiYgIWRldmljZVRva2VuTWF0Y2hlc1swXVsnaW5zdGFsbGF0aW9uSWQnXSkge1xuICAgICAgICAgIC8vIEV4YWN0bHkgb25lIGRldmljZSB0b2tlbiBtYXRjaCBhbmQgaXQgZG9lc24ndCBoYXZlIGFuIGluc3RhbGxhdGlvblxuICAgICAgICAgIC8vIElELiBUaGUgdHdvIHJvd3MgcmVwcmVzZW50IHRoZSBzYW1lIGluc3RhbGw7IHJlc29sdmUgdGhlIG1lcmdlIHBlclxuICAgICAgICAgIC8vIHRoZSBjb25maWd1cmVkIG9wdGlvbnMuXG4gICAgICAgICAgY29uc3QgaW5zdGFsbGF0aW9uT3B0cyA9IHRoaXMuY29uZmlnLmluc3RhbGxhdGlvbiB8fCB7fTtcbiAgICAgICAgICByZXR1cm4gSW5zdGFsbGF0aW9uRGVkdXAuYXBwbHlEdXBsaWNhdGVEZXZpY2VUb2tlbk1lcmdlKHtcbiAgICAgICAgICAgIGRhdGFiYXNlOiB0aGlzLmNvbmZpZy5kYXRhYmFzZSxcbiAgICAgICAgICAgIGlkTWF0Y2gsXG4gICAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoOiBkZXZpY2VUb2tlbk1hdGNoZXNbMF0sXG4gICAgICAgICAgICBhY3Rpb246IGluc3RhbGxhdGlvbk9wdHMuZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24gfHwgJ2RlbGV0ZScsXG4gICAgICAgICAgICBtZXJnZVByaW9yaXR5OiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuTWVyZ2VQcmlvcml0eSB8fCAnZGV2aWNlVG9rZW4nLFxuICAgICAgICAgICAgZW5mb3JjZUF1dGg6IGluc3RhbGxhdGlvbk9wdHMuZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb25FbmZvcmNlQXV0aCA9PT0gdHJ1ZSxcbiAgICAgICAgICAgIHJ1bk9wdGlvbnM6IHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICAgIHZhbGlkU2NoZW1hQ29udHJvbGxlcjogdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiBpZE1hdGNoLmRldmljZVRva2VuICE9IHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgICAgICAgICAgLy8gV2UncmUgc2V0dGluZyB0aGUgZGV2aWNlIHRva2VuIG9uIGFuIGV4aXN0aW5nIGluc3RhbGxhdGlvbiwgc29cbiAgICAgICAgICAgIC8vIHdlIHNob3VsZCB0cnkgY2xlYW5pbmcgb3V0IG9sZCBpbnN0YWxsYXRpb25zIHRoYXQgbWF0Y2ggdGhpc1xuICAgICAgICAgICAgLy8gZGV2aWNlIHRva2VuLlxuICAgICAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICAgIGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgLy8gV2UgaGF2ZSBhIHVuaXF1ZSBpbnN0YWxsIElkLCB1c2UgdGhhdCB0byBwcmVzZXJ2ZVxuICAgICAgICAgICAgLy8gdGhlIGludGVyZXN0aW5nIGluc3RhbGxhdGlvblxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgICAgICBkZWxRdWVyeVsnaW5zdGFsbGF0aW9uSWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgJiZcbiAgICAgICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgPT0gdGhpcy5kYXRhLm9iamVjdElkXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gd2UgcGFzc2VkIGFuIG9iamVjdElkLCBwcmVzZXJ2ZSB0aGF0IGluc3RhbGF0aW9uXG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydvYmplY3RJZCddID0ge1xuICAgICAgICAgICAgICAgICRuZTogaWRNYXRjaC5vYmplY3RJZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIFdoYXQgdG8gZG8gaGVyZT8gY2FuJ3QgcmVhbGx5IGNsZWFuIHVwIGV2ZXJ5dGhpbmcuLi5cbiAgICAgICAgICAgICAgcmV0dXJuIGlkTWF0Y2gub2JqZWN0SWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgICAgLy8gQSBgRGVsZXRlYCBvcGVyYXRpb24gaXMgYXBwbGllZCBvbmx5IGFmdGVyIHRoZSBkZWR1cGxpY2F0aW9uIHJ1bnMsIHNvIHNjb3BlXG4gICAgICAgICAgICAgIC8vIHRoZSBjbGVhbnVwIHRvIHRoZSB2YWx1ZSB0aGUgbWF0Y2hlZCBpbnN0YWxsYXRpb24gc3RpbGwgaG9sZHMuIERyb3BwaW5nIHRoZVxuICAgICAgICAgICAgICAvLyBjb25zdHJhaW50IHdvdWxkIGxldCB0aGUgY2xlYW51cCByZWFjaCBpbnN0YWxsYXRpb25zIG9mIG90aGVyIGFwcGxpY2F0aW9ucyxcbiAgICAgICAgICAgICAgLy8gYW5kIHRoZSBvcGVyYXRpb24gaXRzZWxmIGNhbm5vdCBtYXRjaCBhIFN0cmluZywgc28gc2tpcCB0aGUgY2xlYW51cCB3aGVuIG5vXG4gICAgICAgICAgICAgIC8vIHNjb3BlIGlzIGF2YWlsYWJsZS5cbiAgICAgICAgICAgICAgY29uc3QgYXBwSWRlbnRpZmllciA9XG4gICAgICAgICAgICAgICAgdHlwZW9mIHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgICAgICAgPyB0aGlzLmRhdGEuYXBwSWRlbnRpZmllclxuICAgICAgICAgICAgICAgICAgOiBpZE1hdGNoLmFwcElkZW50aWZpZXI7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgYXBwSWRlbnRpZmllciAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gaWRNYXRjaC5vYmplY3RJZDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBkZWxRdWVyeVsnYXBwSWRlbnRpZmllciddID0gYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGluc3RhbGxhdGlvbk9wdHMgPSB0aGlzLmNvbmZpZy5pbnN0YWxsYXRpb24gfHwge307XG4gICAgICAgICAgICByZXR1cm4gSW5zdGFsbGF0aW9uRGVkdXAucmVtb3ZlQ29uZmxpY3RpbmdEZXZpY2VUb2tlbih7XG4gICAgICAgICAgICAgIGRhdGFiYXNlOiB0aGlzLmNvbmZpZy5kYXRhYmFzZSxcbiAgICAgICAgICAgICAgcXVlcnk6IGRlbFF1ZXJ5LFxuICAgICAgICAgICAgICBhY3Rpb246IGluc3RhbGxhdGlvbk9wdHMuZHVwbGljYXRlRGV2aWNlVG9rZW5BY3Rpb24gfHwgJ2RlbGV0ZScsXG4gICAgICAgICAgICAgIGVuZm9yY2VBdXRoOiBpbnN0YWxsYXRpb25PcHRzLmR1cGxpY2F0ZURldmljZVRva2VuQWN0aW9uRW5mb3JjZUF1dGggPT09IHRydWUsXG4gICAgICAgICAgICAgIHJ1bk9wdGlvbnM6IHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICAgICAgdmFsaWRTY2hlbWFDb250cm9sbGVyOiB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgIH0pLnRoZW4oKCkgPT4gaWRNYXRjaC5vYmplY3RJZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEluIG5vbi1tZXJnZSBzY2VuYXJpb3MsIGp1c3QgcmV0dXJuIHRoZSBpbnN0YWxsYXRpb24gbWF0Y2ggaWRcbiAgICAgICAgICByZXR1cm4gaWRNYXRjaC5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4ob2JqSWQgPT4ge1xuICAgICAgaWYgKG9iaklkKSB7XG4gICAgICAgIHRoaXMucXVlcnkgPSB7IG9iamVjdElkOiBvYmpJZCB9O1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcbiAgICAgIH1cbiAgICAgIC8vIFRPRE86IFZhbGlkYXRlIG9wcyAoYWRkL3JlbW92ZSBvbiBjaGFubmVscywgJGluYyBvbiBiYWRnZSwgZXRjLilcbiAgICB9KTtcbiAgcmV0dXJuIHByb21pc2U7XG59O1xuXG4vLyBJZiB3ZSBzaG9ydC1jaXJjdWl0ZWQgdGhlIG9iamVjdCByZXNwb25zZSAtIHRoZW4gd2UgbmVlZCB0byBtYWtlIHN1cmUgd2UgZXhwYW5kIGFsbCB0aGUgZmlsZXMsXG4vLyBzaW5jZSB0aGlzIG1pZ2h0IG5vdCBoYXZlIGEgcXVlcnksIG1lYW5pbmcgaXQgd29uJ3QgcmV0dXJuIHRoZSBmdWxsIHJlc3VsdCBiYWNrLlxuLy8gVE9ETzogKG5sdXRzZW5rbykgVGhpcyBzaG91bGQgZGllIHdoZW4gd2UgbW92ZSB0byBwZXItY2xhc3MgYmFzZWQgY29udHJvbGxlcnMgb24gX1Nlc3Npb24vX1VzZXJcblJlc3RXcml0ZS5wcm90b3R5cGUuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIC8vIENoZWNrIHdoZXRoZXIgd2UgaGF2ZSBhIHNob3J0LWNpcmN1aXRlZCByZXNwb25zZSAtIG9ubHkgdGhlbiBydW4gZXhwYW5zaW9uLlxuICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgYXdhaXQgdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QodGhpcy5jb25maWcsIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpO1xuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkRhdGFiYXNlT3BlcmF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Sb2xlJykge1xuICAgIGlmICh0aGlzLmRhdGEgJiYgdGhpcy5kYXRhLnVzZXJzICYmIHRoaXMuZGF0YS51c2Vycy5vYmplY3RzKSB7XG4gICAgICB0aGlzLmRhdGEudXNlcnMub2JqZWN0cy5mb3JFYWNoKCh7IG9iamVjdElkIH0pID0+IHtcbiAgICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnJvbGUuZGVsKG9iamVjdElkKTtcbiAgICAgICAgaWYgKHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIpIHtcbiAgICAgICAgICB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLmNsZWFyQ2FjaGVkUm9sZXMoUGFyc2UuVXNlci5jcmVhdGVXaXRob3V0RGF0YShvYmplY3RJZCkpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnJvbGUuY2xlYXIoKTtcbiAgICAgIGlmICh0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyKSB7XG4gICAgICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIuY2xlYXJDYWNoZWRSb2xlcyh0aGlzLmF1dGgudXNlcik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmIHRoaXMucXVlcnkgJiYgdGhpcy5hdXRoLmlzVW5hdXRoZW50aWNhdGVkKCkpIHtcbiAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLlNFU1NJT05fTUlTU0lORyxcbiAgICAgIGBDYW5ub3QgbW9kaWZ5IHVzZXIgJHt0aGlzLnF1ZXJ5Lm9iamVjdElkfS5gLFxuICAgICAgdGhpcy5jb25maWdcbiAgICApO1xuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1Byb2R1Y3QnICYmIHRoaXMuZGF0YS5kb3dubG9hZCkge1xuICAgIHRoaXMuZGF0YS5kb3dubG9hZE5hbWUgPSB0aGlzLmRhdGEuZG93bmxvYWQubmFtZTtcbiAgfVxuXG4gIC8vIFRPRE86IEFkZCBiZXR0ZXIgZGV0ZWN0aW9uIGZvciBBQ0wsIGVuc3VyaW5nIGEgdXNlciBjYW4ndCBiZSBsb2NrZWQgZnJvbVxuICAvLyAgICAgICB0aGVpciBvd24gdXNlciByZWNvcmQuXG4gIGlmICh0aGlzLmRhdGEuQUNMICYmIHRoaXMuZGF0YS5BQ0xbJyp1bnJlc29sdmVkJ10pIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9BQ0wsICdJbnZhbGlkIEFDTC4nKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgLy8gRm9yY2UgdGhlIHVzZXIgdG8gbm90IGxvY2tvdXRcbiAgICAvLyBNYXRjaGVkIHdpdGggcGFyc2UuY29tXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5BQ0wgJiZcbiAgICAgIHRoaXMuYXV0aC5pc01hc3RlciAhPT0gdHJ1ZSAmJlxuICAgICAgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UgIT09IHRydWVcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5BQ0xbdGhpcy5xdWVyeS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgfVxuICAgIC8vIHVwZGF0ZSBwYXNzd29yZCB0aW1lc3RhbXAgaWYgdXNlciBwYXNzd29yZCBpcyBiZWluZyBjaGFuZ2VkXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2VcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSk7XG4gICAgfVxuICAgIC8vIElnbm9yZSBjcmVhdGVkQXQgd2hlbiB1cGRhdGVcbiAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcblxuICAgIGxldCBkZWZlciA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIC8vIGlmIHBhc3N3b3JkIGhpc3RvcnkgaXMgZW5hYmxlZCB0aGVuIHNhdmUgdGhlIGN1cnJlbnQgcGFzc3dvcmQgdG8gaGlzdG9yeVxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeVxuICAgICkge1xuICAgICAgZGVmZXIgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAuZmluZChcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMucXVlcnkub2JqZWN0SWQgfSxcbiAgICAgICAgICB7IGtleXM6IFsnX3Bhc3N3b3JkX2hpc3RvcnknLCAnX2hhc2hlZF9wYXNzd29yZCddIH0sXG4gICAgICAgICAgQXV0aC5tYWludGVuYW5jZSh0aGlzLmNvbmZpZylcbiAgICAgICAgKVxuICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggIT0gMSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCB1c2VyID0gcmVzdWx0c1swXTtcbiAgICAgICAgICBsZXQgb2xkUGFzc3dvcmRzID0gW107XG4gICAgICAgICAgaWYgKHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnkpIHtcbiAgICAgICAgICAgIG9sZFBhc3N3b3JkcyA9IF8udGFrZShcbiAgICAgICAgICAgICAgdXNlci5fcGFzc3dvcmRfaGlzdG9yeSxcbiAgICAgICAgICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5XG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvL24tMSBwYXNzd29yZHMgZ28gaW50byBoaXN0b3J5IGluY2x1ZGluZyBsYXN0IHBhc3N3b3JkXG4gICAgICAgICAgd2hpbGUgKFxuICAgICAgICAgICAgb2xkUGFzc3dvcmRzLmxlbmd0aCA+IE1hdGgubWF4KDAsIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDIpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICBvbGRQYXNzd29yZHMuc2hpZnQoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9oaXN0b3J5ID0gb2xkUGFzc3dvcmRzO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gZGVmZXIudGhlbigoKSA9PiB7XG4gICAgICAvLyBSdW4gYW4gdXBkYXRlXG4gICAgICAvLyBUaGUgdW5zYW5pdGl6ZWQgcmVzdWx0IG9mIGEgY2xpZW50IHVwZGF0ZSBjYXJyaWVzIHRoZSByZWFkIGFjY2VzcyBvZiB0aGUgb2JqZWN0XG4gICAgICBjb25zdCByYXcgPSAhdGhpcy5ydW5PcHRpb25zLm1hbnkgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2U7XG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgLnVwZGF0ZShcbiAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICB0aGlzLnF1ZXJ5LFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgcmF3LFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgICAgIClcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICB0aGlzLl90aHJvd0lmQXV0aERhdGFEdXBsaWNhdGUoZXJyb3IpO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbihhc3luYyByZXN1bHQgPT4ge1xuICAgICAgICAgIGxldCByZXNwb25zZSA9IHJlc3VsdDtcbiAgICAgICAgICBpZiAocmF3KSB7XG4gICAgICAgICAgICB0aGlzLndyaXR0ZW5SZWFkQWNjZXNzID0gcmVzdWx0Ll9ycGVybTtcbiAgICAgICAgICAgIHRoaXMud3JpdHRlbk9iamVjdCA9IHJlc3VsdDtcbiAgICAgICAgICAgIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UuX3Nhbml0aXplRGF0YWJhc2VSZXN1bHQodGhpcy5kYXRhLCByZXN1bHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXNwb25zZS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICAgICAgICB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKHJlc3BvbnNlLCB0aGlzLmRhdGEpO1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UgPSB7IHJlc3BvbnNlIH07XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIC8vIFNldCB0aGUgZGVmYXVsdCBBQ0wgYW5kIHBhc3N3b3JkIHRpbWVzdGFtcCBmb3IgdGhlIG5ldyBfVXNlclxuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgICAgdmFyIEFDTCA9IHRoaXMuZGF0YS5BQ0w7XG4gICAgICAvLyBkZWZhdWx0IHB1YmxpYyByL3cgQUNMXG4gICAgICBpZiAoIUFDTCkge1xuICAgICAgICBBQ0wgPSB7fTtcbiAgICAgICAgaWYgKCF0aGlzLmNvbmZpZy5lbmZvcmNlUHJpdmF0ZVVzZXJzKSB7XG4gICAgICAgICAgQUNMWycqJ10gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiBmYWxzZSB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBtYWtlIHN1cmUgdGhlIHVzZXIgaXMgbm90IGxvY2tlZCBkb3duXG4gICAgICBBQ0xbdGhpcy5kYXRhLm9iamVjdElkXSA9IHsgcmVhZDogdHJ1ZSwgd3JpdGU6IHRydWUgfTtcbiAgICAgIHRoaXMuZGF0YS5BQ0wgPSBBQ0w7XG4gICAgICAvLyBwYXNzd29yZCB0aW1lc3RhbXAgdG8gYmUgdXNlZCB3aGVuIHBhc3N3b3JkIGV4cGlyeSBwb2xpY3kgaXMgZW5mb3JjZWRcbiAgICAgIGlmICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZSkge1xuICAgICAgICB0aGlzLmRhdGEuX3Bhc3N3b3JkX2NoYW5nZWRfYXQgPSBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKCkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFJ1biBhIGNyZWF0ZVxuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmNyZWF0ZSh0aGlzLmNsYXNzTmFtZSwgdGhpcy5kYXRhLCB0aGlzLnJ1bk9wdGlvbnMsIGZhbHNlLCB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlcilcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCBlcnJvci5jb2RlICE9PSBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUpIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuX3Rocm93SWZBdXRoRGF0YUR1cGxpY2F0ZShlcnJvcik7XG5cbiAgICAgICAgLy8gUXVpY2sgY2hlY2ssIGlmIHdlIHdlcmUgYWJsZSB0byBpbmZlciB0aGUgZHVwbGljYXRlZCBmaWVsZCBuYW1lXG4gICAgICAgIGlmIChlcnJvciAmJiBlcnJvci51c2VySW5mbyAmJiBlcnJvci51c2VySW5mby5kdXBsaWNhdGVkX2ZpZWxkID09PSAndXNlcm5hbWUnKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfVEFLRU4sXG4gICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChlcnJvciAmJiBlcnJvci51c2VySW5mbyAmJiBlcnJvci51c2VySW5mby5kdXBsaWNhdGVkX2ZpZWxkID09PSAnZW1haWwnKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgdGhpcyB3YXMgYSBmYWlsZWQgdXNlciBjcmVhdGlvbiBkdWUgdG8gdXNlcm5hbWUgb3IgZW1haWwgYWxyZWFkeSB0YWtlbiwgd2UgbmVlZCB0b1xuICAgICAgICAvLyBjaGVjayB3aGV0aGVyIGl0IHdhcyB1c2VybmFtZSBvciBlbWFpbCBhbmQgcmV0dXJuIHRoZSBhcHByb3ByaWF0ZSBlcnJvci5cbiAgICAgICAgLy8gRmFsbGJhY2sgdG8gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgICAgICAvLyBUT0RPOiBTZWUgaWYgd2UgY2FuIGxhdGVyIGRvIHRoaXMgd2l0aG91dCBhZGRpdGlvbmFsIHF1ZXJpZXMgYnkgdXNpbmcgbmFtZWQgaW5kZXhlcy5cbiAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgICAgLmZpbmQoXG4gICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSxcbiAgICAgICAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7IGxpbWl0OiAxIH1cbiAgICAgICAgICApXG4gICAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICAgIHsgZW1haWw6IHRoaXMuZGF0YS5lbWFpbCwgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSB9LFxuICAgICAgICAgICAgICB7IGxpbWl0OiAxIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgIHJlc3BvbnNlLm9iamVjdElkID0gdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICByZXNwb25zZS5jcmVhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgICAgIGlmICh0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lKSB7XG4gICAgICAgICAgcmVzcG9uc2UudXNlcm5hbWUgPSB0aGlzLmRhdGEudXNlcm5hbWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShyZXNwb25zZSwgdGhpcy5kYXRhKTtcbiAgICAgICAgLy8gUmVhZCBhY2Nlc3MgYXMgc3RvcmVkXG4gICAgICAgIGNvbnN0IGFjbCA9IHRoaXMuZGF0YS5BQ0w7XG4gICAgICAgIHRoaXMud3JpdHRlblJlYWRBY2Nlc3MgPSBhY2wgPyBPYmplY3Qua2V5cyhhY2wpLmZpbHRlcihrZXkgPT4gYWNsW2tleV0ucmVhZCkgOiBudWxsO1xuICAgICAgICB0aGlzLndyaXR0ZW5PYmplY3QgPSB0aGlzLmRhdGE7XG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgICAgc3RhdHVzOiAyMDEsXG4gICAgICAgICAgcmVzcG9uc2UsXG4gICAgICAgICAgbG9jYXRpb246IHRoaXMubG9jYXRpb24oKSxcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICB9XG59O1xuXG4vLyBSZXR1cm5zIG5vdGhpbmcgLSBkb2Vzbid0IHdhaXQgZm9yIHRoZSB0cmlnZ2VyLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5BZnRlclNhdmVUcmlnZ2VyID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMucmVzcG9uc2UgfHwgIXRoaXMucmVzcG9uc2UucmVzcG9uc2UgfHwgdGhpcy5ydW5PcHRpb25zLm1hbnkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdhZnRlclNhdmUnIHRyaWdnZXIgZm9yIHRoaXMgY2xhc3MuXG4gIGNvbnN0IGhhc0FmdGVyU2F2ZUhvb2sgPSB0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRyaWdnZXJzLlR5cGVzLmFmdGVyU2F2ZSxcbiAgICB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkXG4gICk7XG4gIGNvbnN0IGhhc0xpdmVRdWVyeSA9IHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIuaGFzTGl2ZVF1ZXJ5KHRoaXMuY2xhc3NOYW1lKTtcbiAgaWYgKCFoYXNBZnRlclNhdmVIb29rICYmICFoYXNMaXZlUXVlcnkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjb25zdCB7IG9yaWdpbmFsT2JqZWN0LCB1cGRhdGVkT2JqZWN0IH0gPSB0aGlzLmJ1aWxkUGFyc2VPYmplY3RzKCk7XG4gIHVwZGF0ZWRPYmplY3QuX2hhbmRsZVNhdmVSZXNwb25zZShcbiAgICB0aGlzLmNsb25lV2l0aEZpbGVVcmxzKHRoaXMucmVzcG9uc2UucmVzcG9uc2UpLFxuICAgIHRoaXMucmVzcG9uc2Uuc3RhdHVzIHx8IDIwMFxuICApO1xuXG4gIGlmIChoYXNMaXZlUXVlcnkpIHtcbiAgICB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICAgIC8vIE5vdGlmeSBMaXZlUXVlcnlTZXJ2ZXIgaWYgcG9zc2libGVcbiAgICAgICAgY29uc3QgcGVybXMgPSBzY2hlbWFDb250cm9sbGVyLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyh1cGRhdGVkT2JqZWN0LmNsYXNzTmFtZSk7XG4gICAgICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIub25BZnRlclNhdmUoXG4gICAgICAgICAgdXBkYXRlZE9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgdXBkYXRlZE9iamVjdCxcbiAgICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgICBwZXJtc1xuICAgICAgICApO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ0xpdmVRdWVyeSBhZnRlclNhdmUgbm90aWZpY2F0aW9uIGZhaWxlZCcsIGVycik7XG4gICAgICB9KTtcbiAgfVxuICBpZiAoIWhhc0FmdGVyU2F2ZUhvb2spIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gUnVuIGFmdGVyU2F2ZSB0cmlnZ2VyXG4gIHJldHVybiB0cmlnZ2Vyc1xuICAgIC5tYXliZVJ1blRyaWdnZXIoXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgb3JpZ2luYWxPYmplY3QsXG4gICAgICB0aGlzLmNvbmZpZyxcbiAgICAgIHRoaXMuY29udGV4dFxuICAgIClcbiAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgY29uc3QganNvblJldHVybmVkID0gcmVzdWx0ICYmICFyZXN1bHQuX3RvRnVsbEpTT047XG4gICAgICBpZiAoanNvblJldHVybmVkKSB7XG4gICAgICAgIC8vIFRoZSByZXR1cm5lZCBvYmplY3QgaXMgdGhlIHJlc3BvbnNlIGFzIGlzXG4gICAgICAgIHRoaXMuc3RvcmFnZS5yZXNwb25zZUZyb21UcmlnZ2VyID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5wZW5kaW5nT3BzLm9wZXJhdGlvbnMgPSB7fTtcbiAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZSA9IHJlc3VsdDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UgPSB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKFxuICAgICAgICAgIChyZXN1bHQgfHwgdXBkYXRlZE9iamVjdCkudG9KU09OKCksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBsb2dnZXIud2FybignYWZ0ZXJTYXZlIGNhdWdodCBhbiBlcnJvcicsIGVycik7XG4gICAgfSk7XG59O1xuXG4vLyBBIGhlbHBlciB0byBmaWd1cmUgb3V0IHdoYXQgbG9jYXRpb24gdGhpcyBvcGVyYXRpb24gaGFwcGVucyBhdC5cblJlc3RXcml0ZS5wcm90b3R5cGUubG9jYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBtaWRkbGUgPSB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyA/ICcvdXNlcnMvJyA6ICcvY2xhc3Nlcy8nICsgdGhpcy5jbGFzc05hbWUgKyAnLyc7XG4gIGNvbnN0IG1vdW50ID0gdGhpcy5jb25maWcubW91bnQgfHwgdGhpcy5jb25maWcuc2VydmVyVVJMO1xuICByZXR1cm4gbW91bnQgKyBtaWRkbGUgKyB0aGlzLmRhdGEub2JqZWN0SWQ7XG59O1xuXG4vLyBBIGhlbHBlciB0byBnZXQgdGhlIG9iamVjdCBpZCBmb3IgdGhpcyBvcGVyYXRpb24uXG4vLyBCZWNhdXNlIGl0IGNvdWxkIGJlIGVpdGhlciBvbiB0aGUgcXVlcnkgb3Igb24gdGhlIGRhdGFcblJlc3RXcml0ZS5wcm90b3R5cGUub2JqZWN0SWQgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLmRhdGEub2JqZWN0SWQgfHwgdGhpcy5xdWVyeS5vYmplY3RJZDtcbn07XG5cbi8vIFJldHVybnMgYSBjb3B5IG9mIHRoZSBkYXRhIGFuZCBkZWxldGUgYmFkIGtleXMgKF9hdXRoX2RhdGEsIF9oYXNoZWRfcGFzc3dvcmQuLi4pXG5SZXN0V3JpdGUucHJvdG90eXBlLnNhbml0aXplZERhdGEgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IGRhdGEgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLnJlZHVjZSgoZGF0YSwga2V5KSA9PiB7XG4gICAgLy8gUmVnZXhwIGNvbWVzIGZyb20gUGFyc2UuT2JqZWN0LnByb3RvdHlwZS52YWxpZGF0ZVxuICAgIGlmICghL15bQS1aYS16XVswLTlBLVphLXpfXSokLy50ZXN0KGtleSkpIHtcbiAgICAgIGRlbGV0ZSBkYXRhW2tleV07XG4gICAgfVxuICAgIHJldHVybiBkYXRhO1xuICB9LCB0aGlzLmNsb25lV2l0aEZpbGVVcmxzKHRoaXMuZGF0YSkpO1xuICByZXR1cm4gUGFyc2UuX2RlY29kZSh1bmRlZmluZWQsIGRhdGEpO1xufTtcblxuLy8gQSByYXcgdmlldyBvZiB0aGUgb2JqZWN0J3MgZmllbGRzIChzdG9yZWQgdmFsdWVzIG92ZXJsYWlkIHdpdGggd2hvbGUtZmllbGRcbi8vIHdyaXRlcyBpbiB0aGlzIHJlcXVlc3QpIHVzZWQgdG8gcmVzb2x2ZSB3aGV0aGVyIGEgZG90IG5vdGF0aW9uIGtleSB0YXJnZXRzIGFcbi8vIHBvaW50ZXIncyBvYmplY3QgSUQuXG5SZXN0V3JpdGUucHJvdG90eXBlLl9kb3ROb3RhdGlvbkZpZWxkUm9vdCA9IGZ1bmN0aW9uICgpIHtcbiAgY29uc3Qgcm9vdCA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgaWYgKHRoaXMuZGF0YSkge1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHRoaXMuZGF0YSkpIHtcbiAgICAgIGlmIChrZXkuaW5kZXhPZignLicpIDwgMCkge1xuICAgICAgICByb290W2tleV0gPSB0aGlzLmRhdGFba2V5XTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvb3Q7XG59O1xuXG5jb25zdCBwcm9oaWJpdGVkRG90Tm90YXRpb25LZXkgPSBrZXkgPT5cbiAgbmV3IFBhcnNlLkVycm9yKFxuICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgYFByb2hpYml0ZWQgZG90IG5vdGF0aW9uIGtleSBpbiByZXF1ZXN0IGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoa2V5KX0uYFxuICApO1xuXG4vLyBWYWx1ZXMgdGhlIFNESyBkZWNvZGVzIHRvIGFuIGluc3RhbmNlIHJhdGhlciB0aGFuIGEgcGxhaW4gb2JqZWN0OiBhbiBvcGVyYXRpb24gb3IgYVxuLy8gdHlwZWQgdmFsdWVcbmNvbnN0IGRlY29kZXNUb0luc3RhbmNlID0gdmFsdWUgPT4ge1xuICBpZiAodHlwZW9mIHZhbHVlLl9fb3AgPT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgc3dpdGNoICh2YWx1ZS5fX3R5cGUpIHtcbiAgICBjYXNlICdQb2ludGVyJzpcbiAgICBjYXNlICdPYmplY3QnOlxuICAgICAgcmV0dXJuICEhdmFsdWUuY2xhc3NOYW1lO1xuICAgIGNhc2UgJ1JlbGF0aW9uJzpcbiAgICBjYXNlICdEYXRlJzpcbiAgICBjYXNlICdGaWxlJzpcbiAgICBjYXNlICdHZW9Qb2ludCc6XG4gICAgY2FzZSAnUG9seWdvbic6XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIGZhbHNlO1xuICB9XG59O1xuXG4vLyBXaGV0aGVyIHRoZSBTREsgd291bGQgcmVzb2x2ZSBhIG5vbi1sZWFmIHNlZ21lbnQgb2YgdGhlIGtleSwgZnJvbSB0aGUgZ2l2ZW4gZGVwdGhcbi8vIG9uLCB0aHJvdWdoIHRoZSBwcm90b3R5cGUgY2hhaW4gb2YgdGhlIGNvbnRhaW5lciBpbnN0ZWFkIG9mIGFuIG93biBrZXksIHdyaXRpbmdcbi8vIHRoZSBmaW5hbCBzZWdtZW50IG9udG8gYSBzaGFyZWQgYnVpbHQtaW4uXG5jb25zdCBkZXNjZW5kc0ludG9Qcm90b3R5cGUgPSAoY29udGFpbmVyLCBzZWdtZW50cywgZGVwdGggPSAwKSA9PiB7XG4gIGZvciAobGV0IGkgPSBkZXB0aDsgaSA8IHNlZ21lbnRzLmxlbmd0aCAtIDE7IGkrKykge1xuICAgIGlmIChjb250YWluZXIgPT09IG51bGwgfHwgdHlwZW9mIGNvbnRhaW5lciAhPT0gJ29iamVjdCcpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgLy8gQSBmdXJ0aGVyIHNlZ21lbnQgd2Fsa3MgdGhlIHByb3RvdHlwZSBvZiB0aGUgZGVjb2RlZCBpbnN0YW5jZVxuICAgIGlmIChkZWNvZGVzVG9JbnN0YW5jZShjb250YWluZXIpKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgY29uc3Qgc2VnbWVudCA9IHNlZ21lbnRzW2ldO1xuICAgIGlmICghaGFzT3duKGNvbnRhaW5lciwgc2VnbWVudCkpIHtcbiAgICAgIC8vIEFuIGluaGVyaXRlZCBtZW1iZXIgb2YgYSBuZXN0ZWQgdmFsdWUgcmVzb2x2ZXMgdG8gYSBzaGFyZWQgYnVpbHQtaW47IHRoZSByb290XG4gICAgICAvLyBoYXMgbm8gcHJvdG90eXBlIGluIHRoZSBTREssIGFuZCBhIG1pc3Npbmcga2V5IGlzIGNyZWF0ZWQgZnJlc2hcbiAgICAgIHJldHVybiBpID4gMCAmJiBzZWdtZW50IGluIGNvbnRhaW5lcjtcbiAgICB9XG4gICAgY29udGFpbmVyID0gY29udGFpbmVyW3NlZ21lbnRdO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn07XG5cbi8vIFRoZSBjb250YWluZXIgYSB3cml0dGVuIHZhbHVlIHByb3ZpZGVzIGZvciBrZXlzIGJlbG93IGl0OiB0aGUgdmFsdWUgaXRzZWxmLCBvclxuLy8gdGhlIGVsZW1lbnRzIGFuIGFycmF5IG9wZXJhdGlvbiBhZGRzXG5jb25zdCB3cml0dGVuQ29udGFpbmVyID0gdmFsdWUgPT4ge1xuICBpZiAodmFsdWUgPT09IG51bGwgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0Jykge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZS5fX29wID09PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBBcnJheS5pc0FycmF5KHZhbHVlLm9iamVjdHMpID8gdmFsdWUub2JqZWN0cyA6IHVuZGVmaW5lZDtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59O1xuXG4vLyBSZWplY3RzIGEgZG90IG5vdGF0aW9uIGtleSB0aGF0IHRoZSBTREsgd291bGQgYXBwbHkgdGhyb3VnaCBhIHByb3RvdHlwZSBtZW1iZXIgb2Zcbi8vIHRoZSBzdG9yZWQgb2JqZWN0ICh0aGUgdHJpZ2dlciBvYmplY3QgaXMgYnVpbHQgZnJvbSBpdCBiZWZvcmUgdGhlIG90aGVyIGZpZWxkcyBvZlxuLy8gdGhpcyByZXF1ZXN0IGFyZSBhcHBsaWVkKSwgb2YgdGhlIG9iamVjdCBhcyB3cml0dGVuIGJ5IHRoaXMgcmVxdWVzdCwgb3Igb2YgYSB2YWx1ZVxuLy8gYW5vdGhlciBrZXkgb2YgdGhpcyByZXF1ZXN0IHdyaXRlcyBhYm92ZSBpdC5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVEb3ROb3RhdGlvbktleXMgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEpO1xuICBjb25zdCBrZXlTZXQgPSBuZXcgU2V0KGtleXMpO1xuICBjb25zdCByb290cyA9IFt0aGlzLl9kb3ROb3RhdGlvbkZpZWxkUm9vdCgpXTtcbiAgaWYgKHRoaXMub3JpZ2luYWxEYXRhKSB7XG4gICAgcm9vdHMucHVzaCh0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIH1cbiAgLy8gT25seSBhIGtleSB0aGF0IGlzIGEgcHJlZml4IG9mIHRoaXMga2V5LCBlbmRpbmcgb24gYSBzZWdtZW50IGJvdW5kYXJ5LCB3cml0ZXMgYWJvdmUgaXRcbiAgY29uc3Qgd3JpdHRlbkFib3ZlID0gc2VnbWVudHMgPT4ge1xuICAgIGxldCBwcmVmaXggPSBzZWdtZW50c1swXTtcbiAgICBmb3IgKGxldCBkZXB0aCA9IDE7IGRlcHRoIDwgc2VnbWVudHMubGVuZ3RoIC0gMTsgZGVwdGgrKykge1xuICAgICAgaWYgKGtleVNldC5oYXMocHJlZml4KSkge1xuICAgICAgICBjb25zdCBjb250YWluZXIgPSB3cml0dGVuQ29udGFpbmVyKHRoaXMuZGF0YVtwcmVmaXhdKTtcbiAgICAgICAgaWYgKGNvbnRhaW5lciAhPT0gdW5kZWZpbmVkICYmIGRlc2NlbmRzSW50b1Byb3RvdHlwZShjb250YWluZXIsIHNlZ21lbnRzLCBkZXB0aCkpIHtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcHJlZml4ICs9IGAuJHtzZWdtZW50c1tkZXB0aF19YDtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9O1xuICBmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XG4gICAgaWYgKGtleS5pbmRleE9mKCcuJykgPCAwKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3Qgc2VnbWVudHMgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICBpZiAocm9vdHMuc29tZShyb290ID0+IGRlc2NlbmRzSW50b1Byb3RvdHlwZShyb290LCBzZWdtZW50cykpIHx8IHdyaXR0ZW5BYm92ZShzZWdtZW50cykpIHtcbiAgICAgIHRocm93IHByb2hpYml0ZWREb3ROb3RhdGlvbktleShrZXkpO1xuICAgIH1cbiAgfVxufTtcblxuLy8gUmV0dXJucyBhbiB1cGRhdGVkIGNvcHkgb2YgdGhlIG9iamVjdFxuUmVzdFdyaXRlLnByb3RvdHlwZS5idWlsZFBhcnNlT2JqZWN0cyA9IGZ1bmN0aW9uICgpIHtcbiAgY29uc3QgZXh0cmFEYXRhID0geyBjbGFzc05hbWU6IHRoaXMuY2xhc3NOYW1lLCBvYmplY3RJZDogdGhpcy5xdWVyeT8ub2JqZWN0SWQgfTtcbiAgbGV0IG9yaWdpbmFsT2JqZWN0O1xuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgb3JpZ2luYWxPYmplY3QgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdGhpcy5vcmlnaW5hbERhdGEpO1xuICB9XG5cbiAgY29uc3QgY2xhc3NOYW1lID0gUGFyc2UuT2JqZWN0LmZyb21KU09OKGV4dHJhRGF0YSk7XG4gIGNvbnN0IHJlYWRPbmx5QXR0cmlidXRlcyA9IGNsYXNzTmFtZS5jb25zdHJ1Y3Rvci5yZWFkT25seUF0dHJpYnV0ZXNcbiAgICA/IGNsYXNzTmFtZS5jb25zdHJ1Y3Rvci5yZWFkT25seUF0dHJpYnV0ZXMoKVxuICAgIDogW107XG5cbiAgLy8gRm9yIF9Sb2xlIGNsYXNzLCAnbmFtZScgY2Fubm90IGJlIHNldCBhZnRlciB0aGUgcm9sZSBoYXMgYW4gb2JqZWN0SWQuXG4gIC8vIEluIGFmdGVyU2F2ZSBjb250ZXh0LCBfaGFuZGxlU2F2ZVJlc3BvbnNlIGhhcyBhbHJlYWR5IHNldCB0aGUgb2JqZWN0SWQsXG4gIC8vIHNvIHdlIHRyZWF0ICduYW1lJyBhcyByZWFkLW9ubHkgdG8gYXZvaWQgUGFyc2UgU0RLIHZhbGlkYXRpb24gZXJyb3JzLlxuICBjb25zdCBpc1JvbGVBZnRlclNhdmUgPSB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Sb2xlJyAmJiB0aGlzLnJlc3BvbnNlICYmICF0aGlzLnF1ZXJ5O1xuICBpZiAoaXNSb2xlQWZ0ZXJTYXZlICYmIHRoaXMuZGF0YS5uYW1lICYmICFyZWFkT25seUF0dHJpYnV0ZXMuaW5jbHVkZXMoJ25hbWUnKSkge1xuICAgIHJlYWRPbmx5QXR0cmlidXRlcy5wdXNoKCduYW1lJyk7XG4gIH1cbiAgaWYgKCF0aGlzLm9yaWdpbmFsRGF0YSkge1xuICAgIGZvciAoY29uc3QgYXR0cmlidXRlIG9mIHJlYWRPbmx5QXR0cmlidXRlcykge1xuICAgICAgZXh0cmFEYXRhW2F0dHJpYnV0ZV0gPSB0aGlzLmRhdGFbYXR0cmlidXRlXTtcbiAgICB9XG4gIH1cbiAgY29uc3QgdXBkYXRlZE9iamVjdCA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIGNvbnN0IHBvaW50ZXJSb290ID0gdGhpcy5fZG90Tm90YXRpb25GaWVsZFJvb3QoKTtcbiAgT2JqZWN0LmtleXModGhpcy5kYXRhKS5yZWR1Y2UoZnVuY3Rpb24gKGRhdGEsIGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgLy8gTnVsbCBhbmQgdW5kZWZpbmVkIGFyZSBzZXQgYXQgdGhlaXIgb3duIGRvdCBub3RhdGlvbiBwYXRoLCBsaWtlIGFuIG9wZXJhdGlvblxuICAgICAgaWYgKGRhdGFba2V5XSA9PSBudWxsIHx8IHR5cGVvZiBkYXRhW2tleV0uX19vcCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgLy8gQSBkb3Qgbm90YXRpb24ga2V5IHRoYXQgcmVtb3ZlcyBhIHBvaW50ZXIncyBvYmplY3QgSUQgd291bGQgbGVhdmUgdGhlXG4gICAgICAgIC8vIHBvaW50ZXIgdW5zZXJpYWxpemFibGUgYW5kIGJyZWFrIHRoZSB0cmlnZ2VyIG9iamVjdCwgc28gc2tpcCBpdC5cbiAgICAgICAgaWYgKCFyZWFkT25seUF0dHJpYnV0ZXMuaW5jbHVkZXMoa2V5KSAmJiAhdGFyZ2V0c1BvaW50ZXJJZChwb2ludGVyUm9vdCwga2V5KSkge1xuICAgICAgICAgIC8vIFRoZSBTREsga2V5IG5hbWUgcnVsZXMgYXBwbHkgdG8gdG9wLWxldmVsIGZpZWxkcyBvbmx5XG4gICAgICAgICAgdXBkYXRlZE9iamVjdC5zZXQoa2V5LCBkYXRhW2tleV0sIHsgaWdub3JlVmFsaWRhdGlvbjogdHJ1ZSB9KTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gc3ViZG9jdW1lbnQga2V5IHdpdGggZG90IG5vdGF0aW9uIHsgJ3gueSc6IHYgfSA9PiB7ICd4JzogeyAneScgOiB2IH0gfSlcbiAgICAgICAgY29uc3Qgc3BsaXR0ZWRLZXkgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgICAgY29uc3QgcGFyZW50UHJvcCA9IHNwbGl0dGVkS2V5WzBdO1xuICAgICAgICBsZXQgcGFyZW50VmFsID0gdXBkYXRlZE9iamVjdC5nZXQocGFyZW50UHJvcCk7XG4gICAgICAgIGlmICh0eXBlb2YgcGFyZW50VmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICAgIHBhcmVudFZhbCA9IHt9O1xuICAgICAgICB9XG4gICAgICAgIHBhcmVudFZhbFtzcGxpdHRlZEtleVsxXV0gPSBkYXRhW2tleV07XG4gICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KHBhcmVudFByb3AsIHBhcmVudFZhbCk7XG4gICAgICB9XG4gICAgICBkZWxldGUgZGF0YVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfSwgdGhpcy5jbG9uZVdpdGhGaWxlVXJscyh0aGlzLmRhdGEpKTtcblxuICBjb25zdCBzYW5pdGl6ZWQgPSB0aGlzLnNhbml0aXplZERhdGEoKTtcbiAgZm9yIChjb25zdCBhdHRyaWJ1dGUgb2YgcmVhZE9ubHlBdHRyaWJ1dGVzKSB7XG4gICAgZGVsZXRlIHNhbml0aXplZFthdHRyaWJ1dGVdO1xuICB9XG4gIHVwZGF0ZWRPYmplY3Quc2V0KHNhbml0aXplZCk7XG4gIHJldHVybiB7IHVwZGF0ZWRPYmplY3QsIG9yaWdpbmFsT2JqZWN0IH07XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNsZWFuVXNlckF1dGhEYXRhID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlICYmIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgY29uc3QgdXNlciA9IHRoaXMucmVzcG9uc2UucmVzcG9uc2U7XG4gICAgaWYgKHVzZXIuYXV0aERhdGEpIHtcbiAgICAgIE9iamVjdC5rZXlzKHVzZXIuYXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICBpZiAodXNlci5hdXRoRGF0YVtwcm92aWRlcl0gPT09IG51bGwpIHtcbiAgICAgICAgICBkZWxldGUgdXNlci5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgaWYgKE9iamVjdC5rZXlzKHVzZXIuYXV0aERhdGEpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuLy8gU3RyaXBzIHByb3RlY3RlZCBmaWVsZHMgZnJvbSB0aGUgd3JpdGUgcmVzcG9uc2Ugd2hlbiBwcm90ZWN0ZWRGaWVsZHNTYXZlUmVzcG9uc2VFeGVtcHQgaXMgZmFsc2UuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbHRlclByb3RlY3RlZEZpZWxkc0luUmVzcG9uc2UgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNvbmZpZy5wcm90ZWN0ZWRGaWVsZHNTYXZlUmVzcG9uc2VFeGVtcHQgIT09IGZhbHNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIgfHwgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCF0aGlzLnJlc3BvbnNlIHx8ICF0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHNjaGVtYUNvbnRyb2xsZXIgPSBhd2FpdCB0aGlzLmNvbmZpZy5kYXRhYmFzZS5sb2FkU2NoZW1hKCk7XG4gIGNvbnN0IHByb3RlY3RlZEZpZWxkcyA9IHRoaXMuY29uZmlnLmRhdGFiYXNlLmFkZFByb3RlY3RlZEZpZWxkcyhcbiAgICBzY2hlbWFDb250cm9sbGVyLFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRoaXMucXVlcnkgPyB7IG9iamVjdElkOiB0aGlzLnF1ZXJ5Lm9iamVjdElkIH0gOiB7fSxcbiAgICB0aGlzLmF1dGgudXNlciA/IFt0aGlzLmF1dGgudXNlci5pZF0uY29uY2F0KHRoaXMuYXV0aC51c2VyUm9sZXMgfHwgW10pIDogW10sXG4gICAgdGhpcy5hdXRoLFxuICAgIHt9XG4gICk7XG4gIGlmICghcHJvdGVjdGVkRmllbGRzKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHRoaXMucmVzcG9uc2UucmVzcG9uc2UpKSB7XG4gICAgaWYgKHByb3RlY3RlZEZpZWxkcy5zb21lKGZpZWxkID0+IGtleSA9PT0gZmllbGQgfHwga2V5LnN0YXJ0c1dpdGgoYCR7ZmllbGR9LmApKSkge1xuICAgICAgZGVsZXRlIHRoaXMucmVzcG9uc2UucmVzcG9uc2Vba2V5XTtcbiAgICB9XG4gIH1cbn07XG5cbmNvbnN0IGhhc093biA9IChvYmplY3QsIGtleSkgPT5cbiAgb2JqZWN0ICE9PSBudWxsICYmIG9iamVjdCAhPT0gdW5kZWZpbmVkICYmIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmplY3QsIGtleSk7XG5cbi8vIFdoZXRoZXIgYSBkb3Qgbm90YXRpb24gcGF0aCBjYW4gZGVzY2VuZCBpbnRvIHRoZSB2YWx1ZVxuY29uc3QgaXNDb250YWluZXIgPSB2YWx1ZSA9PlxuICB2YWx1ZSAhPT0gbnVsbCAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmICF2YWx1ZS5fX3R5cGUgJiYgIXZhbHVlLl9fb3A7XG5cbi8vIFJlYWRzIGEgZG90IG5vdGF0aW9uIHBhdGggdGhyb3VnaCBvd24gcHJvcGVydGllcyBvZiBjb250YWluZXJzIG9ubHlcbmNvbnN0IGdldE93blBhdGggPSAob2JqZWN0LCBwYXRoKSA9PiB7XG4gIGxldCB2YWx1ZSA9IG9iamVjdDtcbiAgZm9yIChjb25zdCBrZXkgb2YgcGF0aCkge1xuICAgIGlmICghaXNDb250YWluZXIodmFsdWUpIHx8ICFoYXNPd24odmFsdWUsIGtleSkpIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIHZhbHVlID0gdmFsdWVba2V5XTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59O1xuXG4vLyBXaGV0aGVyIGEgZG90IG5vdGF0aW9uIGtleSB0YXJnZXRzIGEgcG9pbnRlcidzIG9iamVjdCBJRCAoYGlkYC9gb2JqZWN0SWRgKS5cbi8vIFJlbW92aW5nIGl0IGxlYXZlcyB0aGUgcG9pbnRlciB1bnNlcmlhbGl6YWJsZSAoYHRvUG9pbnRlcmAgdGhyb3dzKSwgd2hpY2hcbi8vIGNvcnJ1cHRzIHRoZSB0cmlnZ2VyIG9iamVjdDsgb3RoZXIgc3ViLWtleXMgYmVsb3cgYSBwb2ludGVyIGFyZSBsZWZ0IHRvIHRoZVxuLy8gZXhpc3RpbmcgaGFuZGxpbmcuXG5jb25zdCB0YXJnZXRzUG9pbnRlcklkID0gKHJvb3QsIGtleSkgPT4ge1xuICBjb25zdCBzZWdtZW50cyA9IGtleS5zcGxpdCgnLicpO1xuICBmb3IgKGxldCBkZXB0aCA9IDE7IGRlcHRoIDwgc2VnbWVudHMubGVuZ3RoOyBkZXB0aCsrKSB7XG4gICAgY29uc3QgcGFyZW50ID0gZ2V0T3duUGF0aChyb290LCBzZWdtZW50cy5zbGljZSgwLCBkZXB0aCkpO1xuICAgIGlmIChwYXJlbnQgIT09IG51bGwgJiYgdHlwZW9mIHBhcmVudCA9PT0gJ29iamVjdCcgJiYgcGFyZW50Ll9fdHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICBjb25zdCBuZXh0ID0gc2VnbWVudHNbZGVwdGhdO1xuICAgICAgcmV0dXJuIG5leHQgPT09ICdpZCcgfHwgbmV4dCA9PT0gJ29iamVjdElkJztcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufTtcblxuLy8gUmVzdG9yZXMgYSByZXZlcnRlZCBkb3Qgbm90YXRpb24ga2V5IGluIHRoZSByZXNwb25zZVxuUmVzdFdyaXRlLnByb3RvdHlwZS5fcmVzdG9yZVJldmVydGVkUGF0aCA9IGZ1bmN0aW9uIChyZXNwb25zZSwgd3JpdGVEYXRhLCB3cml0dGVuLCBrZXksIGZpbmFsT2JqZWN0KSB7XG4gIC8vIEEgd3JpdGUgYXQgb3IgYmVuZWF0aCB0aGUga2V5IGdvdmVybnNcbiAgaWYgKHdyaXR0ZW4uc29tZShrID0+IGsgPT09IGtleSB8fCBrLnN0YXJ0c1dpdGgoYCR7a2V5fS5gKSkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcGF0aCA9IGtleS5zcGxpdCgnLicpO1xuICAvLyBBIHJldHVybmVkIG9iamVjdCB3aXRob3V0IHRoZSBmaWVsZCBsZWF2ZXMgdGhlIHN0b3JlZCB2YWx1ZVxuICBjb25zdCBmcm9tRmluYWwgPSAhIWZpbmFsT2JqZWN0ICYmIGhhc093bihmaW5hbE9iamVjdCwgcGF0aFswXSk7XG4gIGxldCB2YWx1ZSA9IGZyb21GaW5hbCA/IGZpbmFsT2JqZWN0IDogdGhpcy5vcmlnaW5hbERhdGEgfHwge307XG4gIGxldCBkZXB0aCA9IDA7XG4gIGxldCBhdXRob3JpdGF0aXZlID0gZnJvbUZpbmFsO1xuICBpZiAoIWZyb21GaW5hbCkge1xuICAgIC8vIEEgd3JpdHRlbiBhbmNlc3RvciBnb3Zlcm5zOyBjb21wdXRlZCBvcGVyYXRpb25zIGFyZSByZXR1cm5lZCBleHBhbmRlZFxuICAgIGNvbnN0IGFuY2VzdG9yID0gd3JpdHRlblxuICAgICAgLmZpbHRlcihrID0+IGtleS5zdGFydHNXaXRoKGAke2t9LmApKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IGIubGVuZ3RoIC0gYS5sZW5ndGgpWzBdO1xuICAgIGlmIChhbmNlc3Rvcikge1xuICAgICAgY29uc3QgYW5jZXN0b3JQYXRoID0gYW5jZXN0b3Iuc3BsaXQoJy4nKTtcbiAgICAgIGxldCByZXR1cm5lZCA9IGdldE93blBhdGgocmVzcG9uc2UsIGFuY2VzdG9yUGF0aCk7XG4gICAgICAvLyBBbiB1bmNoYW5nZWQgY29tcHV0ZWQgcmVzdWx0IGlzIG5vIGxvbmdlciBpbiB0aGUgcmVzcG9uc2VcbiAgICAgIGNvbnN0IG9wID0gd3JpdGVEYXRhW2FuY2VzdG9yXT8uX19vcDtcbiAgICAgIGlmIChyZXR1cm5lZCA9PT0gdW5kZWZpbmVkICYmIG9wICYmIG9wICE9PSAnRGVsZXRlJykge1xuICAgICAgICByZXR1cm5lZCA9IGdldE93blBhdGgodGhpcy5vcmlnaW5hbERhdGEsIGFuY2VzdG9yUGF0aCk7XG4gICAgICB9XG4gICAgICB2YWx1ZSA9IHJldHVybmVkICE9PSB1bmRlZmluZWQgPyByZXR1cm5lZCA6IHdyaXRlRGF0YVthbmNlc3Rvcl07XG4gICAgICBpZiAoIWlzQ29udGFpbmVyKHZhbHVlKSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBkZXB0aCA9IGFuY2VzdG9yUGF0aC5sZW5ndGg7XG4gICAgICBhdXRob3JpdGF0aXZlID0gdHJ1ZTtcbiAgICB9XG4gIH1cbiAgd2hpbGUgKGRlcHRoIDwgcGF0aC5sZW5ndGggJiYgaXNDb250YWluZXIodmFsdWUpICYmIGhhc093bih2YWx1ZSwgcGF0aFtkZXB0aF0pKSB7XG4gICAgdmFsdWUgPSB2YWx1ZVtwYXRoW2RlcHRoKytdXTtcbiAgfVxuICAvLyBBIG1pc3NpbmcgYXJyYXkgaW5kZXggcmV0dXJucyB0aGUgd2hvbGUgYXJyYXksIHNvIHRoZSBjbGllbnQga2VlcHMgbm8gaG9sZVxuICBjb25zdCBtaXNzaW5nSW5kZXggPSBkZXB0aCA8IHBhdGgubGVuZ3RoICYmIEFycmF5LmlzQXJyYXkodmFsdWUpICYmIC9eXFxkKyQvLnRlc3QocGF0aFtkZXB0aF0pO1xuICBpZiAoZGVwdGggPCBwYXRoLmxlbmd0aCAmJiAhbWlzc2luZ0luZGV4KSB7XG4gICAgaWYgKGlzQ29udGFpbmVyKHZhbHVlKSkge1xuICAgICAgLy8gRGVsZXRlIGF0IHRoZSBmaXJzdCBtaXNzaW5nIGtleVxuICAgICAgZGVwdGgrKztcbiAgICAgIHZhbHVlID0gdW5kZWZpbmVkO1xuICAgIH0gZWxzZSBpZiAodmFsdWU/Ll9fb3ApIHtcbiAgICAgIHJldHVybjtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgdW5jaGFuZ2VkID0gdXRpbC5pc0RlZXBTdHJpY3RFcXVhbChcbiAgICAgICAgdmFsdWUsXG4gICAgICAgIGdldE93blBhdGgodGhpcy5vcmlnaW5hbERhdGEsIHBhdGguc2xpY2UoMCwgZGVwdGgpKVxuICAgICAgKTtcbiAgICAgIGlmICghZnJvbUZpbmFsIHx8IHVuY2hhbmdlZCkge1xuICAgICAgICAvLyBDbGVhcnMgdGhlIGNsaWVudCBvcGVyYXRpb24gYmVuZWF0aCBhbiB1bmNoYW5nZWQgdHlwZWQgdmFsdWVcbiAgICAgICAgaWYgKHZhbHVlPy5fX3R5cGUgJiYgdW5jaGFuZ2VkKSB7XG4gICAgICAgICAgcmVzcG9uc2Vba2V5XSA9IHsgX19vcDogJ0RlbGV0ZScgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGNvbnN0IHRhcmdldCA9IHBhdGguc2xpY2UoMCwgZGVwdGgpLmpvaW4oJy4nKTtcbiAgY29uc3Qga2V5cyA9IFsuLi53cml0dGVuLCAuLi5PYmplY3Qua2V5cyhyZXNwb25zZSldO1xuICBjb25zdCBvdmVybGFwcyA9IHByZWZpeCA9PlxuICAgIGtleXMuc29tZShrID0+IGsgPT09IHByZWZpeCB8fCBrLnN0YXJ0c1dpdGgoYCR7cHJlZml4fS5gKSB8fCBwcmVmaXguc3RhcnRzV2l0aChgJHtrfS5gKSk7XG4gIGlmICghYXV0aG9yaXRhdGl2ZSAmJiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCBtaXNzaW5nSW5kZXgpICYmIG92ZXJsYXBzKHRhcmdldCkpIHtcbiAgICAvLyBBbm90aGVyIHdyaXRlIGNyZWF0ZXMgdGhlIHBhdGg7IGNsZWFyIHRoZSBzaGFsbG93ZXN0IHVudG91Y2hlZCByZXZlcnRlZCBwYXJ0XG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZvciAobGV0IGxlbmd0aCA9IGRlcHRoICsgMTsgbGVuZ3RoIDw9IHBhdGgubGVuZ3RoOyBsZW5ndGgrKykge1xuICAgICAgICBjb25zdCBwcmVmaXggPSBwYXRoLnNsaWNlKDAsIGxlbmd0aCkuam9pbignLicpO1xuICAgICAgICBpZiAoIW92ZXJsYXBzKHByZWZpeCkpIHtcbiAgICAgICAgICByZXNwb25zZVtwcmVmaXhdID0geyBfX29wOiAnRGVsZXRlJyB9O1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBmb3IgKGNvbnN0IHJlc3BvbnNlS2V5IG9mIE9iamVjdC5rZXlzKHJlc3BvbnNlKSkge1xuICAgIGlmIChyZXNwb25zZUtleS5zdGFydHNXaXRoKGAke3RhcmdldH0uYCkpIHtcbiAgICAgIGRlbGV0ZSByZXNwb25zZVtyZXNwb25zZUtleV07XG4gICAgfVxuICB9XG4gIHJlc3BvbnNlW3RhcmdldF0gPSB2YWx1ZSA9PT0gdW5kZWZpbmVkID8geyBfX29wOiAnRGVsZXRlJyB9IDogdmFsdWU7XG59O1xuXG4vLyBUaGUgdmFsdWUgb2YgYW4gb3BlcmF0aW9uIGFwcGxpZWQgdG8gYW4gZW1wdHkgdmFsdWVcbmNvbnN0IGFwcGxpZWRUb0VtcHR5ID0gdmFsdWUgPT4ge1xuICBzd2l0Y2ggKHZhbHVlPy5fX29wKSB7XG4gICAgY2FzZSAnSW5jcmVtZW50JzpcbiAgICAgIHJldHVybiB2YWx1ZS5hbW91bnQ7XG4gICAgY2FzZSAnQWRkJzpcbiAgICAgIHJldHVybiB2YWx1ZS5vYmplY3RzO1xuICAgIGNhc2UgJ0FkZFVuaXF1ZSc6XG4gICAgICByZXR1cm4gXy51bmlxV2l0aCh2YWx1ZS5vYmplY3RzLCB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKTtcbiAgICBjYXNlICdSZW1vdmUnOlxuICAgICAgcmV0dXJuIFtdO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gdmFsdWU7XG4gIH1cbn07XG5cbi8vIFNldHMgdGhlIGRvdCBub3RhdGlvbiBrZXlzIG9mIHRoZSByZXF1ZXN0IGluIHRoZSByZXNwb25zZSwgYXBwbGllZCB0byBhbiBlbXB0eSB2YWx1ZVxuUmVzdFdyaXRlLnByb3RvdHlwZS5fc2V0UmVxdWVzdFBhdGhzID0gZnVuY3Rpb24gKHJlc3BvbnNlKSB7XG4gIC8vIEZpZWxkcyB0aGUgcmVzcG9uc2Uga2VlcHMsIHN1Y2ggYXMgb2JqZWN0SWRcbiAgY29uc3Qga2VwdCA9IE9iamVjdC5rZXlzKHJlc3BvbnNlKTtcbiAgY29uc3QgYXJyYXlzID0gbmV3IFNldCgpO1xuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiB0aGlzLnJlcXVlc3RPcGVyYXRpb25zKSB7XG4gICAgY29uc3Qgc2VnbWVudHMgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICBpZiAoc2VnbWVudHMubGVuZ3RoIDwgMiB8fCBrZXB0LmluY2x1ZGVzKHNlZ21lbnRzWzBdKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIFRoZSBTREsgY2Fubm90IGFwcGx5IGEgZG90IG5vdGF0aW9uIHBhdGggdG8gQUNMXG4gICAgaWYgKHNlZ21lbnRzWzBdID09PSAnQUNMJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IG9wID0gdmFsdWU/Ll9fb3A7XG4gICAgLy8gQW5vdGhlciBvcGVyYXRpb24sIHN1Y2ggYXMgYSByZWxhdGlvbiBvcGVyYXRpb24sIGhhcyBubyB2YWx1ZVxuICAgIGlmIChvcCAmJiBvcCAhPT0gJ0RlbGV0ZScgJiYgIWNvbXB1dGVkT3BlcmF0aW9ucy5pbmNsdWRlcyhvcCkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBBbiBpbmRleCBiZWxvdyBhbiBBcnJheSBmaWVsZFxuICAgIGlmIChcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyLmdldEV4cGVjdGVkVHlwZSh0aGlzLmNsYXNzTmFtZSwgc2VnbWVudHNbMF0pPy50eXBlID09PSAnQXJyYXknICYmXG4gICAgICAvXlxcZCskLy50ZXN0KHNlZ21lbnRzWzFdKVxuICAgICkge1xuICAgICAgYXJyYXlzLmFkZChzZWdtZW50c1swXSk7XG4gICAgfVxuICAgIGxldCBjb250YWluZXIgPSByZXNwb25zZTtcbiAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygc2VnbWVudHMuc2xpY2UoMCwgLTEpKSB7XG4gICAgICBpZiAoIWhhc093bihjb250YWluZXIsIHNlZ21lbnQpIHx8ICFpc0NvbnRhaW5lcihjb250YWluZXJbc2VnbWVudF0pKSB7XG4gICAgICAgIGNvbnRhaW5lcltzZWdtZW50XSA9IHt9O1xuICAgICAgfVxuICAgICAgY29udGFpbmVyID0gY29udGFpbmVyW3NlZ21lbnRdO1xuICAgIH1cbiAgICAvLyBBbiB1bnNldCBsZWF2ZXMgb25seSB0aGUgcGFyZW50c1xuICAgIGlmIChvcCAhPT0gJ0RlbGV0ZScpIHtcbiAgICAgIGNvbnRhaW5lcltzZWdtZW50c1tzZWdtZW50cy5sZW5ndGggLSAxXV0gPSBhcHBsaWVkVG9FbXB0eSh2YWx1ZSk7XG4gICAgfVxuICB9XG4gIC8vIE9ubHkgdGhlIGVsZW1lbnRzIG9mIHRoZSByZXF1ZXN0LCBpbiBpbmRleCBvcmRlclxuICBmb3IgKGNvbnN0IGZpZWxkIG9mIGFycmF5cykge1xuICAgIHJlc3BvbnNlW2ZpZWxkXSA9IE9iamVjdC52YWx1ZXMocmVzcG9uc2VbZmllbGRdKTtcbiAgfVxufTtcblxuLy8gV2hldGhlciB0aGUgY2FsbGVyIGNhbiByZWFkIHRoZSBvYmplY3QgYXMgd3JpdHRlbjsgY2hhbmdlcyBhZnRlciB0aGUgd3JpdGUgYXJlIG5vdCBjb25zaWRlcmVkXG5SZXN0V3JpdGUucHJvdG90eXBlLl9jYW5SZWFkV3JpdHRlbk9iamVjdCA9IGZ1bmN0aW9uIChhY2xHcm91cCkge1xuICBjb25zdCByZWFkZXJzID0gdGhpcy53cml0dGVuUmVhZEFjY2VzcztcbiAgLy8gQSB3cml0ZSByZXN1bHQgd2l0aG91dCB2YWxpZCByZWFkIGFjY2VzcyBmYWlscyBjbG9zZWRcbiAgaWYgKHJlYWRlcnMgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkocmVhZGVycykpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgLy8gVGhlIG9iamVjdCBBQ0xcbiAgaWYgKHJlYWRlcnMgJiYgIXJlYWRlcnMuc29tZShyZWFkZXIgPT4gYWNsR3JvdXAuaW5jbHVkZXMocmVhZGVyKSkpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgLy8gQSBjbGllbnQgcmVhZHMgYSBzZXNzaW9uIHdpdGggYSBmaW5kIGNvbnN0cmFpbmVkIHRvIHRoZSBzZXNzaW9uIHVzZXJcbiAgY29uc3Qgb3BlcmF0aW9uID0gdGhpcy5jbGFzc05hbWUgPT09ICdfU2Vzc2lvbicgPyAnZmluZCcgOiAnZ2V0JztcbiAgY29uc3QgcGVybWlzc2lvbnMgPSB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlci5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnModGhpcy5jbGFzc05hbWUpO1xuICBpZiAoXG4gICAgU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLnBlcm1pc3Npb25EZW5pYWwoXG4gICAgICBwZXJtaXNzaW9ucyxcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgYWNsR3JvdXAsXG4gICAgICBvcGVyYXRpb25cbiAgICApXG4gICkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICAvLyBUaGUgcG9pbnRlciBwZXJtaXNzaW9ucyBvZiB0aGUgd3JpdHRlbiBvYmplY3RcbiAgY29uc3QgdXNlcnMgPSBhY2xHcm91cC5maWx0ZXIoZW50cnkgPT4gZW50cnkgIT09ICcqJyAmJiAhZW50cnkuc3RhcnRzV2l0aCgncm9sZTonKSk7XG4gIHJldHVybiBTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXIudGVzdFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICBwZXJtaXNzaW9ucyxcbiAgICBhY2xHcm91cCxcbiAgICBvcGVyYXRpb24sXG4gICAgdXNlcnMubGVuZ3RoID09PSAxID8gdXNlcnNbMF0gOiB1bmRlZmluZWQsXG4gICAgZmllbGQgPT4ge1xuICAgICAgbGV0IHZhbHVlID0gdGhpcy53cml0dGVuT2JqZWN0Py5bZmllbGRdO1xuICAgICAgLy8gQSBjcmVhdGUgc3RvcmVzIGFuIG9wZXJhdGlvbiBhcHBsaWVkIHRvIGFuIGVtcHR5IHZhbHVlXG4gICAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgICAgdmFsdWUgPSBhcHBsaWVkVG9FbXB0eSh2YWx1ZSk7XG4gICAgICB9XG4gICAgICAvLyBBbiB1cGRhdGUgcmVzdWx0IG9mIHRoZSBQb3N0Z3JlcyBhZGFwdGVyIGhhcyB0aGUgb2JqZWN0SWQgb2YgYSBwb2ludGVyXG4gICAgICBjb25zdCBleHBlY3RlZCA9IHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyLmdldEV4cGVjdGVkVHlwZSh0aGlzLmNsYXNzTmFtZSwgZmllbGQpO1xuICAgICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgZXhwZWN0ZWQ/LnR5cGUgPT09ICdQb2ludGVyJ1xuICAgICAgICA/IHsgX190eXBlOiAnUG9pbnRlcicsIGNsYXNzTmFtZTogZXhwZWN0ZWQudGFyZ2V0Q2xhc3MsIG9iamVjdElkOiB2YWx1ZSB9XG4gICAgICAgIDogdmFsdWU7XG4gICAgfVxuICApO1xufTtcblxuLy8gUmV0dXJucyBzdG9yZWQgdmFsdWVzIGluIGEgc2F2ZSByZXNwb25zZSBvbmx5IGlmIHRoZSBjYWxsZXIgY2FuIHJlYWQgdGhlIG9iamVjdCBhcyB3cml0dGVuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbHRlclVucmVhZGFibGVGaWVsZHNJblJlc3BvbnNlID0gZnVuY3Rpb24gKCkge1xuICBjb25zdCByZXNwb25zZSA9IHRoaXMucmVzcG9uc2U/LnJlc3BvbnNlO1xuICBpZiAoIXJlc3BvbnNlIHx8IHRoaXMuc3RvcmFnZS5yZXNwb25zZUZyb21UcmlnZ2VyKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIExvZ2luIGFuZCBzZXNzaW9uIHJlcXVlc3RzIGJ1aWxkIHRoZWlyIG93biByZXNwb25zZVxuICBpZiAoIXRoaXMucXVlcnkgJiYgdGhpcy53cml0dGVuUmVhZEFjY2VzcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIgfHwgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gQSBzZXNzaW9uIHRva2VuIGlzc3VlZCBieSB0aGlzIHJlcXVlc3QgaXMgbm90IGEgc3RvcmVkIHZhbHVlXG4gIGNvbnN0IGlzc3VlZCA9IHRoaXMuc3RvcmFnZS5pc3N1ZWRTZXNzaW9uVG9rZW47XG4gIC8vIE5vciBpcyBhIHJlcXVpcmVkIGNvbHVtbiB0aGF0IGVjaG9lcyB0aGUgY2FsbGVyJ3MgdW5jaGFuZ2VkIGlucHV0XG4gIGNvbnN0IGVjaG9lZCA9IGtleSA9PlxuICAgIChyZXF1aXJlZENvbHVtbnMucmVhZFt0aGlzLmNsYXNzTmFtZV0gfHwgW10pLmluY2x1ZGVzKGtleSkgJiZcbiAgICAhKHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIHx8IFtdKS5pbmNsdWRlcyhrZXkpICYmXG4gICAgIShrZXkgPT09ICd1c2VybmFtZScgJiYgdGhpcy5yZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSkgJiZcbiAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKHJlc3BvbnNlW2tleV0sIHRoaXMuZGF0YVtrZXldKTtcbiAgY29uc3QgZmllbGRzID0gT2JqZWN0LmtleXMocmVzcG9uc2UpLmZpbHRlcihcbiAgICBrZXkgPT5cbiAgICAgICFbJ29iamVjdElkJywgJ2NyZWF0ZWRBdCcsICd1cGRhdGVkQXQnXS5pbmNsdWRlcyhrZXkpICYmXG4gICAgICAhKGtleSA9PT0gJ3Nlc3Npb25Ub2tlbicgJiYgaXNzdWVkICYmIHJlc3BvbnNlW2tleV0gPT09IGlzc3VlZCkgJiZcbiAgICAgICFlY2hvZWQoa2V5KVxuICApO1xuICBpZiAoIWZpZWxkcy5sZW5ndGgpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gQSBzaWduLXVwIHJlc3BvbnNlIGlzIGZvciB0aGUgbmV3IHVzZXIgaWYgaXQgaXNzdWVzIHRoZSBuZXcgdXNlciBhIHNlc3Npb25cbiAgY29uc3Qgc2lnblVwID0gIXRoaXMucXVlcnkgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiYgISFpc3N1ZWQ7XG4gIGNvbnN0IGFjbEdyb3VwID0gc2lnblVwID8gWycqJywgdGhpcy5kYXRhLm9iamVjdElkXSA6IHRoaXMucnVuT3B0aW9ucy5hY2wgfHwgW107XG4gIGlmICghdGhpcy5fY2FuUmVhZFdyaXR0ZW5PYmplY3QoYWNsR3JvdXApKSB7XG4gICAgLy8gTm8gc3RvcmVkIHZhbHVlcyBmb3IgYSBjYWxsZXIgd2hvIGNhbm5vdCByZWFkIHRoZSBvYmplY3RcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBmaWVsZHMpIHtcbiAgICAgIGRlbGV0ZSByZXNwb25zZVtrZXldO1xuICAgIH1cbiAgICB0aGlzLl9zZXRSZXF1ZXN0UGF0aHMocmVzcG9uc2UpO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBBIGZpZWxkIHJldmVydGVkIGluIGJlZm9yZVNhdmUgaGFzIHRoZSB2YWx1ZSBvZiB0aGUgb3JpZ2luYWwgb2JqZWN0LCB3aGljaCB0cmlnZ2VycyB0aGF0IGFyZVxuICAvLyBleGVtcHQgZnJvbSBwcm90ZWN0ZWQgZmllbGRzIHJlYWQgd2l0aCB0aGUgbWFzdGVyIGtleVxuICBpZiAodGhpcy5jb25maWcucHJvdGVjdGVkRmllbGRzVHJpZ2dlckV4ZW1wdCAmJiB0aGlzLnF1ZXJ5ICYmIHRoaXMucGVuZGluZ09wcy5vcGVyYXRpb25zKSB7XG4gICAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gICAgY29uc3QgW3BlbmRpbmddID0gc3RhdGVDb250cm9sbGVyLmdldFBlbmRpbmdPcHModGhpcy5wZW5kaW5nT3BzLmlkZW50aWZpZXIpO1xuICAgIGNvbnN0IHJldmVydGVkID0gT2JqZWN0LmtleXModGhpcy5wZW5kaW5nT3BzLm9wZXJhdGlvbnMpLmZpbHRlcihrZXkgPT4gIXBlbmRpbmdba2V5XSk7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgZmllbGRzKSB7XG4gICAgICBpZiAoXG4gICAgICAgIHJldmVydGVkLnNvbWUoXG4gICAgICAgICAgcGF0aCA9PiBwYXRoID09PSBrZXkgfHwgcGF0aC5zdGFydHNXaXRoKGAke2tleX0uYCkgfHwga2V5LnN0YXJ0c1dpdGgoYCR7cGF0aH0uYClcbiAgICAgICAgKVxuICAgICAgKSB7XG4gICAgICAgIGRlbGV0ZSByZXNwb25zZVtrZXldO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSA9IGZ1bmN0aW9uIChyZXNwb25zZSwgZGF0YSwgaXNGaW5hbE9iamVjdCA9IGZhbHNlKSB7XG4gIGNvbnN0IHN0YXRlQ29udHJvbGxlciA9IFBhcnNlLkNvcmVNYW5hZ2VyLmdldE9iamVjdFN0YXRlQ29udHJvbGxlcigpO1xuICBjb25zdCBbcGVuZGluZ10gPSBzdGF0ZUNvbnRyb2xsZXIuZ2V0UGVuZGluZ09wcyh0aGlzLnBlbmRpbmdPcHMuaWRlbnRpZmllcik7XG4gIGxldCByZXZlcnRlZERhdGE7XG4gIGNvbnN0IHJldmVydGVkUGF0aHMgPSBbXTtcbiAgZm9yIChjb25zdCBrZXkgaW4gdGhpcy5wZW5kaW5nT3BzLm9wZXJhdGlvbnMpIHtcbiAgICBpZiAocGVuZGluZ1trZXldKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gVGhlIFNESyBjYW5ub3QgYXBwbHkgYW4gb3BlcmF0aW9uIG9yIGEgZG90IG5vdGF0aW9uIHBhdGggdG8gQUNMXG4gICAgaWYgKGtleS5zdGFydHNXaXRoKCdBQ0wuJykgfHwgKGtleSA9PT0gJ0FDTCcgJiYgIWhhc093bih0aGlzLm9yaWdpbmFsRGF0YSwgJ0FDTCcpKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChrZXkuaW5jbHVkZXMoJy4nKSkge1xuICAgICAgcmV2ZXJ0ZWRQYXRocy5wdXNoKGtleSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gUmVzcG9uc2Ugb25seTsgdGhlIHdyaXRlIGRhdGEgYnVpbGRzIHRoZSBhZnRlclNhdmUgYW5kIExpdmVRdWVyeSBvYmplY3RzXG4gICAgcmV2ZXJ0ZWREYXRhIHx8PSB7IC4uLmRhdGEgfTtcbiAgICByZXZlcnRlZERhdGFba2V5XSA9IGhhc093bih0aGlzLm9yaWdpbmFsRGF0YSwga2V5KVxuICAgICAgPyB0aGlzLm9yaWdpbmFsRGF0YVtrZXldXG4gICAgICA6IHsgX19vcDogJ0RlbGV0ZScgfTtcbiAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciB8fD0gW107XG4gICAgLy8gT25jZSBvbmx5LCBzbyBhbiBhZnRlclNhdmUgdW5zZXQgaXMgbm90IHVuZG9uZSBieSBhIHNlY29uZCBlbnRyeVxuICAgIGlmICh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5pbmRleE9mKGtleSkgPCAwKSB7XG4gICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5wdXNoKGtleSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHJlc3BvbnNlRGF0YSA9IHJldmVydGVkRGF0YSB8fCBkYXRhO1xuICAvLyBUaGUgZmluYWwgb2JqZWN0LCBiZWZvcmUgdW5jaGFuZ2VkIGZpZWxkcyBhcmUgcmVtb3ZlZCBmcm9tIHRoZSByZXNwb25zZVxuICBjb25zdCBmaW5hbE9iamVjdCA9IGlzRmluYWxPYmplY3QgJiYgcmV2ZXJ0ZWRQYXRocy5sZW5ndGggPyB7IC4uLnJlc3BvbnNlIH0gOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHNraXBLZXlzID0gWy4uLihyZXF1aXJlZENvbHVtbnMucmVhZFt0aGlzLmNsYXNzTmFtZV0gfHwgW10pXTtcbiAgaWYgKCF0aGlzLnF1ZXJ5KSB7XG4gICAgc2tpcEtleXMucHVzaCgnb2JqZWN0SWQnLCAnY3JlYXRlZEF0Jyk7XG4gIH0gZWxzZSB7XG4gICAgc2tpcEtleXMucHVzaCgndXBkYXRlZEF0Jyk7XG4gICAgZGVsZXRlIHJlc3BvbnNlLm9iamVjdElkO1xuICB9XG4gIC8vIFRoZSBjbGllbnQncyBvcGVyYXRpb24gcmVzdWx0cyBhbmQgZG90IG5vdGF0aW9uIHBhcmVudHMsIGFsc28gaWYgdW5jaGFuZ2VkXG4gIGNvbnN0IHJlcXVlc3RlZCA9IHRoaXMucmVxdWVzdE9wZXJhdGlvbnNcbiAgICAuZmlsdGVyKChba2V5XSkgPT5cbiAgICAgIGtleS5pbmNsdWRlcygnLicpID8gaGFzT3duKGRhdGEsIGtleSkgOiBjb21wdXRlZE9wZXJhdGlvbnMuaW5jbHVkZXMoZGF0YVtrZXldPy5fX29wKVxuICAgIClcbiAgICAubWFwKChba2V5XSkgPT4ga2V5LnNwbGl0KCcuJylbMF0pO1xuICBmb3IgKGNvbnN0IGtleSBpbiByZXNwb25zZSkge1xuICAgIGlmIChza2lwS2V5cy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgdmFsdWUgPSByZXNwb25zZVtrZXldO1xuICAgIGlmIChcbiAgICAgIHZhbHVlID09IG51bGwgfHxcbiAgICAgICh2YWx1ZS5fX3R5cGUgJiYgdmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKHJlc3BvbnNlRGF0YVtrZXldLCB2YWx1ZSkgfHxcbiAgICAgICghcmVxdWVzdGVkLmluY2x1ZGVzKGtleSkgJiYgdXRpbC5pc0RlZXBTdHJpY3RFcXVhbCgodGhpcy5vcmlnaW5hbERhdGEgfHwge30pW2tleV0sIHZhbHVlKSlcbiAgICApIHtcbiAgICAgIGRlbGV0ZSByZXNwb25zZVtrZXldO1xuICAgIH1cbiAgfVxuICAodGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgfHwgW10pLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICBjb25zdCBkYXRhVmFsdWUgPSByZXNwb25zZURhdGFbZmllbGROYW1lXTtcblxuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3BvbnNlLCBmaWVsZE5hbWUpKSB7XG4gICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgIH1cblxuICAgIGlmIChyZXNwb25zZVtmaWVsZE5hbWVdICYmIHJlc3BvbnNlW2ZpZWxkTmFtZV0uX19vcCkge1xuICAgICAgZGVsZXRlIHJlc3BvbnNlW2ZpZWxkTmFtZV07XG4gICAgICBpZiAoZGF0YVZhbHVlLl9fb3AgPT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgcmVzcG9uc2VbZmllbGROYW1lXSA9IGRhdGFWYWx1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICBpZiAocmV2ZXJ0ZWRQYXRocy5sZW5ndGgpIHtcbiAgICBjb25zdCB3cml0dGVuID0gT2JqZWN0LmtleXMoZGF0YSk7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgcmV2ZXJ0ZWRQYXRocykge1xuICAgICAgdGhpcy5fcmVzdG9yZVJldmVydGVkUGF0aChyZXNwb25zZSwgZGF0YSwgd3JpdHRlbiwga2V5LCBmaW5hbE9iamVjdCk7XG4gICAgfVxuICB9XG4gIHJldHVybiByZXNwb25zZTtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IFJlc3RXcml0ZTtcbm1vZHVsZS5leHBvcnRzID0gUmVzdFdyaXRlO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFhQSxJQUFBQSxVQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRSxPQUFBLEdBQUFILHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRyxpQkFBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksTUFBQSxHQUFBSixPQUFBO0FBQ0EsSUFBQUssYUFBQSxHQUFBTCxPQUFBO0FBQ0EsSUFBQU0saUJBQUEsR0FBQUMsdUJBQUEsQ0FBQVAsT0FBQTtBQUF5RCxTQUFBTyx3QkFBQUMsQ0FBQSxFQUFBQyxDQUFBLDZCQUFBQyxPQUFBLE1BQUFDLENBQUEsT0FBQUQsT0FBQSxJQUFBRSxDQUFBLE9BQUFGLE9BQUEsWUFBQUgsdUJBQUEsWUFBQUEsQ0FBQUMsQ0FBQSxFQUFBQyxDQUFBLFNBQUFBLENBQUEsSUFBQUQsQ0FBQSxJQUFBQSxDQUFBLENBQUFLLFVBQUEsU0FBQUwsQ0FBQSxNQUFBTSxDQUFBLEVBQUFDLENBQUEsRUFBQUMsQ0FBQSxLQUFBQyxTQUFBLFFBQUFDLE9BQUEsRUFBQVYsQ0FBQSxpQkFBQUEsQ0FBQSx1QkFBQUEsQ0FBQSx5QkFBQUEsQ0FBQSxTQUFBUSxDQUFBLE1BQUFGLENBQUEsR0FBQUwsQ0FBQSxHQUFBRyxDQUFBLEdBQUFELENBQUEsUUFBQUcsQ0FBQSxDQUFBSyxHQUFBLENBQUFYLENBQUEsVUFBQU0sQ0FBQSxDQUFBTSxHQUFBLENBQUFaLENBQUEsR0FBQU0sQ0FBQSxDQUFBTyxHQUFBLENBQUFiLENBQUEsRUFBQVEsQ0FBQSxnQkFBQVAsQ0FBQSxJQUFBRCxDQUFBLGdCQUFBQyxDQUFBLE9BQUFhLGNBQUEsQ0FBQUMsSUFBQSxDQUFBZixDQUFBLEVBQUFDLENBQUEsT0FBQU0sQ0FBQSxJQUFB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