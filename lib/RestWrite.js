'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _RestQuery = require('./RestQuery');

var _RestQuery2 = _interopRequireDefault(_RestQuery);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _logger = require('./logger');

var _logger2 = _interopRequireDefault(_logger);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// A RestWrite encapsulates everything we need to run an operation
// that writes to the database.
// This could be either a "create" or an "update".

var SchemaController = require('./Controllers/SchemaController');
var deepcopy = require('deepcopy');

const Auth = require('./Auth');
var cryptoUtils = require('./cryptoUtils');
var passwordCrypto = require('./password');
var Parse = require('parse/node');
var triggers = require('./triggers');
var ClientSDK = require('./ClientSDK');


// query and data are both provided in REST API format. So data
// types are encoded by plain old objects.
// If query is null, this is a "create" and the data in data should be
// created.
// Otherwise this is an "update" - the object matching the query
// should get updated with data.
// RestWrite will handle objectId, createdAt, and updatedAt for
// everything. It also knows to use triggers and special modifications
// for the _User class.
function RestWrite(config, auth, className, query, data, originalData, clientSDK) {
  if (auth.isReadOnly) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Cannot perform a write operation when using readOnlyMasterKey');
  }
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.clientSDK = clientSDK;
  this.storage = {};
  this.runOptions = {};
  this.context = {};
  if (!query && data.objectId) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'objectId is an invalid field name.');
  }

  // When the operation is complete, this.response may have several
  // fields.
  // response: the actual data to be returned
  // status: the http status code. if not present, treated like a 200
  // location: the location header. if not present, no location header
  this.response = null;

  // Processing this operation may mutate our data, so we operate on a
  // copy
  this.query = deepcopy(query);
  this.data = deepcopy(data);
  // We never change originalData, so we do not need a deep copy
  this.originalData = originalData;

  // The timestamp we'll use for this whole operation
  this.updatedAt = Parse._encode(new Date()).iso;
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
    return this.runBeforeTrigger();
  }).then(() => {
    return this.validateSchema();
  }).then(() => {
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
    return this.runAfterTrigger();
  }).then(() => {
    return this.cleanUserAuthData();
  }).then(() => {
    return this.response;
  });
};

// Uses the Auth object to get the list of roles, adds the user id
RestWrite.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster) {
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
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className);
      }
    });
  } else {
    return Promise.resolve();
  }
};

// Validates this operation against the schema.
RestWrite.prototype.validateSchema = function () {
  return this.config.database.validateObject(this.className, this.data, this.query, this.runOptions);
};

// Runs any beforeSave triggers against this operation.
// Any change leads to our data being mutated.
RestWrite.prototype.runBeforeTrigger = function () {
  if (this.response) {
    return;
  }

  // Avoid doing any setup for triggers if there is no 'beforeSave' trigger for this class.
  if (!triggers.triggerExists(this.className, triggers.Types.beforeSave, this.config.applicationId)) {
    return Promise.resolve();
  }

  // Cloud code gets a bit of extra data for its objects
  var extraData = { className: this.className };
  if (this.query && this.query.objectId) {
    extraData.objectId = this.query.objectId;
  }

  let originalObject = null;
  const updatedObject = this.buildUpdatedObject(extraData);
  if (this.query && this.query.objectId) {
    // This is an update for existing object.
    originalObject = triggers.inflate(extraData, this.originalData);
  }

  return Promise.resolve().then(() => {
    return triggers.maybeRunTrigger(triggers.Types.beforeSave, this.auth, updatedObject, originalObject, this.config, this.context);
  }).then(response => {
    if (response && response.object) {
      this.storage.fieldsChangedByTrigger = _lodash2.default.reduce(response.object, (result, value, key) => {
        if (!_lodash2.default.isEqual(this.data[key], value)) {
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
  });
};

RestWrite.prototype.setRequiredFieldsIfNeeded = function () {
  if (this.data) {
    // Add default fields
    this.data.updatedAt = this.updatedAt;
    if (!this.query) {
      this.data.createdAt = this.updatedAt;

      // Only assign new objectId if we are creating new object
      if (!this.data.objectId) {
        this.data.objectId = cryptoUtils.newObjectId(this.config.objectIdSize);
      }
    }
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

  if (!this.query && !this.data.authData) {
    if (typeof this.data.username !== 'string' || _lodash2.default.isEmpty(this.data.username)) {
      throw new Parse.Error(Parse.Error.USERNAME_MISSING, 'bad or missing username');
    }
    if (typeof this.data.password !== 'string' || _lodash2.default.isEmpty(this.data.password)) {
      throw new Parse.Error(Parse.Error.PASSWORD_MISSING, 'password is required');
    }
  }

  if (!this.data.authData || !Object.keys(this.data.authData).length) {
    return;
  }

  var authData = this.data.authData;
  var providers = Object.keys(authData);
  if (providers.length > 0) {
    const canHandleAuthData = providers.reduce((canHandle, provider) => {
      var providerAuthData = authData[provider];
      var hasToken = providerAuthData && providerAuthData.id;
      return canHandle && (hasToken || providerAuthData == null);
    }, true);
    if (canHandleAuthData) {
      return this.handleAuthData(authData);
    }
  }
  throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
};

RestWrite.prototype.handleAuthDataValidation = function (authData) {
  const validations = Object.keys(authData).map(provider => {
    if (authData[provider] === null) {
      return Promise.resolve();
    }
    const validateAuthData = this.config.authDataManager.getValidatorForProvider(provider);
    if (!validateAuthData) {
      throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
    }
    return validateAuthData(authData[provider]);
  });
  return Promise.all(validations);
};

RestWrite.prototype.findUsersWithAuthData = function (authData) {
  const providers = Object.keys(authData);
  const query = providers.reduce((memo, provider) => {
    if (!authData[provider]) {
      return memo;
    }
    const queryKey = `authData.${provider}.id`;
    const query = {};
    query[queryKey] = authData[provider].id;
    memo.push(query);
    return memo;
  }, []).filter(q => {
    return typeof q !== 'undefined';
  });

  let findPromise = Promise.resolve([]);
  if (query.length > 0) {
    findPromise = this.config.database.find(this.className, { '$or': query }, {});
  }

  return findPromise;
};

RestWrite.prototype.filteredObjectsByACL = function (objects) {
  if (this.auth.isMaster) {
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

RestWrite.prototype.handleAuthData = function (authData) {
  let results;
  return this.findUsersWithAuthData(authData).then(r => {
    results = this.filteredObjectsByACL(r);
    if (results.length > 1) {
      // More than 1 user with the passed id's
      throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
    }

    this.storage['authProvider'] = Object.keys(authData).join(',');

    if (results.length > 0) {
      const userResult = results[0];
      const mutatedAuthData = {};
      Object.keys(authData).forEach(provider => {
        const providerData = authData[provider];
        const userAuthData = userResult.authData[provider];
        if (!_lodash2.default.isEqual(providerData, userAuthData)) {
          mutatedAuthData[provider] = providerData;
        }
      });
      const hasMutatedAuthData = Object.keys(mutatedAuthData).length !== 0;
      let userId;
      if (this.query && this.query.objectId) {
        userId = this.query.objectId;
      } else if (this.auth && this.auth.user && this.auth.user.id) {
        userId = this.auth.user.id;
      }
      if (!userId || userId === userResult.objectId) {
        // no user making the call
        // OR the user making the call is the right one
        // Login with auth data
        delete results[0].password;

        // need to set the objectId first otherwise location has trailing undefined
        this.data.objectId = userResult.objectId;

        if (!this.query || !this.query.objectId) {
          // this a login call, no userId passed
          this.response = {
            response: userResult,
            location: this.location()
          };
        }
        // If we didn't change the auth data, just keep going
        if (!hasMutatedAuthData) {
          return;
        }
        // We have authData that is updated on login
        // that can happen when token are refreshed,
        // We should update the token and let the user in
        // We should only check the mutated keys
        return this.handleAuthDataValidation(mutatedAuthData).then(() => {
          // IF we have a response, we'll skip the database operation / beforeSave / afterSave etc...
          // we need to set it up there.
          // We are supposed to have a response only on LOGIN with authData, so we skip those
          // If we're not logging in, but just updating the current user, we can safely skip that part
          if (this.response) {
            // Assign the new authData in the response
            Object.keys(mutatedAuthData).forEach(provider => {
              this.response.response.authData[provider] = mutatedAuthData[provider];
            });
            // Run the DB update directly, as 'master'
            // Just update the authData part
            // Then we're good for the user, early exit of sorts
            return this.config.database.update(this.className, { objectId: this.data.objectId }, { authData: mutatedAuthData }, {});
          }
        });
      } else if (userId) {
        // Trying to update auth data but users
        // are different
        if (userResult.objectId !== userId) {
          throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
        }
        // No auth data was mutated, just keep going
        if (!hasMutatedAuthData) {
          return;
        }
      }
    }
    return this.handleAuthDataValidation(authData);
  });
};

// The non-third-party parts of User transformation
RestWrite.prototype.transformUser = function () {
  var promise = Promise.resolve();

  if (this.className !== '_User') {
    return promise;
  }

  if (!this.auth.isMaster && "emailVerified" in this.data) {
    const error = `Clients aren't allowed to manually update email verification.`;
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, error);
  }

  // Do not cleanup session if objectId is not set
  if (this.query && this.objectId()) {
    // If we're updating a _User object, we need to clear out the cache for that user. Find all their
    // session tokens, and remove them from the cache.
    promise = new _RestQuery2.default(this.config, Auth.master(this.config), '_Session', {
      user: {
        __type: "Pointer",
        className: "_User",
        objectId: this.objectId()
      }
    }).execute().then(results => {
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
      if (!this.auth.isMaster) {
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
  // We need to a find to check for duplicate username in case they are missing the unique index on usernames
  // TODO: Check if there is a unique index, and if so, skip this query.
  return this.config.database.find(this.className, { username: this.data.username, objectId: { '$ne': this.objectId() } }, { limit: 1 }).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
    }
    return;
  });
};

RestWrite.prototype._validateEmail = function () {
  if (!this.data.email || this.data.email.__op === 'Delete') {
    return Promise.resolve();
  }
  // Validate basic email address format
  if (!this.data.email.match(/^.+@.+$/)) {
    return Promise.reject(new Parse.Error(Parse.Error.INVALID_EMAIL_ADDRESS, 'Email address format is invalid.'));
  }
  // Same problem for email as above for username
  return this.config.database.find(this.className, { email: this.data.email, objectId: { '$ne': this.objectId() } }, { limit: 1 }).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
    }
    if (!this.data.authData || !Object.keys(this.data.authData).length || Object.keys(this.data.authData).length === 1 && Object.keys(this.data.authData)[0] === 'anonymous') {
      // We updated the email, send a new validation
      this.storage['sendVerificationEmail'] = true;
      this.config.userController.setEmailVerifyToken(this.data);
    }
  });
};

RestWrite.prototype._validatePasswordPolicy = function () {
  if (!this.config.passwordPolicy) return Promise.resolve();
  return this._validatePasswordRequirements().then(() => {
    return this._validatePasswordHistory();
  });
};

RestWrite.prototype._validatePasswordRequirements = function () {
  // check if the password conforms to the defined password policy if configured
  const policyError = 'Password does not meet the Password Policy requirements.';

  // check whether the password meets the password strength requirements
  if (this.config.passwordPolicy.patternValidator && !this.config.passwordPolicy.patternValidator(this.data.password) || this.config.passwordPolicy.validatorCallback && !this.config.passwordPolicy.validatorCallback(this.data.password)) {
    return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, policyError));
  }

  // check whether password contain username
  if (this.config.passwordPolicy.doNotAllowUsername === true) {
    if (this.data.username) {
      // username is not passed during password reset
      if (this.data.password.indexOf(this.data.username) >= 0) return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, policyError));
    } else {
      // retrieve the User object using objectId during password reset
      return this.config.database.find('_User', { objectId: this.objectId() }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }
        if (this.data.password.indexOf(results[0].username) >= 0) return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, policyError));
        return Promise.resolve();
      });
    }
  }
  return Promise.resolve();
};

RestWrite.prototype._validatePasswordHistory = function () {
  // check whether password is repeating from specified history
  if (this.query && this.config.passwordPolicy.maxPasswordHistory) {
    return this.config.database.find('_User', { objectId: this.objectId() }, { keys: ["_password_history", "_hashed_password"] }).then(results => {
      if (results.length != 1) {
        throw undefined;
      }
      const user = results[0];
      let oldPasswords = [];
      if (user._password_history) oldPasswords = _lodash2.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory - 1);
      oldPasswords.push(user.password);
      const newPassword = this.data.password;
      // compare the new password hash with all old password hashes
      const promises = oldPasswords.map(function (hash) {
        return passwordCrypto.compare(newPassword, hash).then(result => {
          if (result) // reject if there is a match
            return Promise.reject("REPEAT_PASSWORD");
          return Promise.resolve();
        });
      });
      // wait for all comparisons to complete
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      }).catch(err => {
        if (err === "REPEAT_PASSWORD") // a match was found
          return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, `New password should not be the same as last ${this.config.passwordPolicy.maxPasswordHistory} passwords.`));
        throw err;
      });
    });
  }
  return Promise.resolve();
};

RestWrite.prototype.createSessionTokenIfNeeded = function () {
  if (this.className !== '_User') {
    return;
  }
  if (this.query) {
    return;
  }
  if (!this.storage['authProvider'] // signup call, with
  && this.config.preventLoginWithUnverifiedEmail // no login without verification
  && this.config.verifyUserEmails) {
    // verification is on
    return; // do not create the session token in that case!
  }
  return this.createSessionToken();
};

RestWrite.prototype.createSessionToken = function () {
  // cloud installationId from Cloud Code,
  // never create session tokens from there.
  if (this.auth.installationId && this.auth.installationId === 'cloud') {
    return;
  }

  const {
    sessionData,
    createSession
  } = Auth.createSession(this.config, {
    userId: this.objectId(),
    createdWith: {
      'action': this.storage['authProvider'] ? 'login' : 'signup',
      'authProvider': this.storage['authProvider'] || 'password'
    },
    installationId: this.auth.installationId
  });

  if (this.response && this.response.response) {
    this.response.response.sessionToken = sessionData.sessionToken;
  }

  return createSession();
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
  this.config.database.destroy('_Session', {
    user,
    installationId,
    sessionToken: { '$ne': sessionToken }
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
    this.config.userController.sendVerificationEmail(this.data);
    return this.handleFollowup.bind(this);
  }
};

// Handles the _Session class specialness.
// Does nothing if this isn't an _Session object.
RestWrite.prototype.handleSession = function () {
  if (this.response || this.className !== '_Session') {
    return;
  }

  if (!this.auth.user && !this.auth.isMaster) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token required.');
  }

  // TODO: Verify proper error to throw
  if (this.data.ACL) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Cannot set ' + 'ACL on a Session.');
  }

  if (this.query) {
    if (this.data.user && !this.auth.isMaster && this.data.user.objectId != this.auth.user.id) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    } else if (this.data.installationId) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    } else if (this.data.sessionToken) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    }
  }

  if (!this.query && !this.auth.isMaster) {
    const additionalSessionData = {};
    for (var key in this.data) {
      if (key === 'objectId' || key === 'user') {
        continue;
      }
      additionalSessionData[key] = this.data[key];
    }

    const { sessionData, createSession } = Auth.createSession(this.config, {
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
  if (!installationId && !this.auth.isMaster) {
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
      'installationId': installationId
    });
  }
  if (this.data.deviceToken) {
    orQueries.push({ 'deviceToken': this.data.deviceToken });
  }

  if (orQueries.length == 0) {
    return;
  }

  promise = promise.then(() => {
    return this.config.database.find('_Installation', {
      '$or': orQueries
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
        // an installation ID. Try cleaning out old installations that match
        // the deviceToken, and return nil to signal that a new object should
        // be created.
        var delQuery = {
          'deviceToken': this.data.deviceToken,
          'installationId': {
            '$ne': installationId
          }
        };
        if (this.data.appIdentifier) {
          delQuery['appIdentifier'] = this.data.appIdentifier;
        }
        this.config.database.destroy('_Installation', delQuery).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored.
            return;
          }
          // rethrow the error
          throw err;
        });
        return;
      }
    } else {
      if (deviceTokenMatches.length == 1 && !deviceTokenMatches[0]['installationId']) {
        // Exactly one device token match and it doesn't have an installation
        // ID. This is the one case where we want to merge with the existing
        // object.
        const delQuery = { objectId: idMatch.objectId };
        return this.config.database.destroy('_Installation', delQuery).then(() => {
          return deviceTokenMatches[0]['objectId'];
        }).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored
            return;
          }
          // rethrow the error
          throw err;
        });
      } else {
        if (this.data.deviceToken && idMatch.deviceToken != this.data.deviceToken) {
          // We're setting the device token on an existing installation, so
          // we should try cleaning out old installations that match this
          // device token.
          const delQuery = {
            'deviceToken': this.data.deviceToken
          };
          // We have a unique install Id, use that to preserve
          // the interesting installation
          if (this.data.installationId) {
            delQuery['installationId'] = {
              '$ne': this.data.installationId
            };
          } else if (idMatch.objectId && this.data.objectId && idMatch.objectId == this.data.objectId) {
            // we passed an objectId, preserve that instalation
            delQuery['objectId'] = {
              '$ne': idMatch.objectId
            };
          } else {
            // What to do here? can't really clean up everything...
            return idMatch.objectId;
          }
          if (this.data.appIdentifier) {
            delQuery['appIdentifier'] = this.data.appIdentifier;
          }
          this.config.database.destroy('_Installation', delQuery).catch(err => {
            if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
              // no deletions were made. Can be ignored.
              return;
            }
            // rethrow the error
            throw err;
          });
        }
        // In non-merge scenarios, just return the installation match id
        return idMatch.objectId;
      }
    }
  }).then(objId => {
    if (objId) {
      this.query = { objectId: objId };
      delete this.data.objectId;
      delete this.data.createdAt;
    }
    // TODO: Validate ops (add/remove on channels, $inc on badge, etc.)
  });
  return promise;
};

// If we short-circuted the object response - then we need to make sure we expand all the files,
// since this might not have a query, meaning it won't return the full result back.
// TODO: (nlutsenko) This should die when we move to per-class based controllers on _Session/_User
RestWrite.prototype.expandFilesForExistingObjects = function () {
  // Check whether we have a short-circuited response - only then run expansion.
  if (this.response && this.response.response) {
    this.config.filesController.expandFilesInObject(this.config, this.response.response);
  }
};

RestWrite.prototype.runDatabaseOperation = function () {
  if (this.response) {
    return;
  }

  if (this.className === '_Role') {
    this.config.cacheController.role.clear();
  }

  if (this.className === '_User' && this.query && this.auth.isUnauthenticated()) {
    throw new Parse.Error(Parse.Error.SESSION_MISSING, `Cannot modify user ${this.query.objectId}.`);
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
    if (this.className === '_User' && this.data.ACL && this.auth.isMaster !== true) {
      this.data.ACL[this.query.objectId] = { read: true, write: true };
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
      defer = this.config.database.find('_User', { objectId: this.objectId() }, { keys: ["_password_history", "_hashed_password"] }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }
        const user = results[0];
        let oldPasswords = [];
        if (user._password_history) {
          oldPasswords = _lodash2.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory);
        }
        //n-1 passwords go into history including last password
        while (oldPasswords.length > this.config.passwordPolicy.maxPasswordHistory - 2) {
          oldPasswords.shift();
        }
        oldPasswords.push(user.password);
        this.data._password_history = oldPasswords;
      });
    }

    return defer.then(() => {
      // Run an update
      return this.config.database.update(this.className, this.query, this.data, this.runOptions).then(response => {
        response.updatedAt = this.updatedAt;
        this._updateResponseWithData(response, this.data);
        this.response = { response };
      });
    });
  } else {
    // Set the default ACL and password timestamp for the new _User
    if (this.className === '_User') {
      var ACL = this.data.ACL;
      // default public r/w ACL
      if (!ACL) {
        ACL = {};
        ACL['*'] = { read: true, write: false };
      }
      // make sure the user is not locked down
      ACL[this.data.objectId] = { read: true, write: true };
      this.data.ACL = ACL;
      // password timestamp to be used when password expiry policy is enforced
      if (this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
        this.data._password_changed_at = Parse._encode(new Date());
      }
    }

    // Run a create
    return this.config.database.create(this.className, this.data, this.runOptions).catch(error => {
      if (this.className !== '_User' || error.code !== Parse.Error.DUPLICATE_VALUE) {
        throw error;
      }

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
      return this.config.database.find(this.className, { username: this.data.username, objectId: { '$ne': this.objectId() } }, { limit: 1 }).then(results => {
        if (results.length > 0) {
          throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
        }
        return this.config.database.find(this.className, { email: this.data.email, objectId: { '$ne': this.objectId() } }, { limit: 1 });
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
RestWrite.prototype.runAfterTrigger = function () {
  if (!this.response || !this.response.response) {
    return;
  }

  // Avoid doing any setup for triggers if there is no 'afterSave' trigger for this class.
  const hasAfterSaveHook = triggers.triggerExists(this.className, triggers.Types.afterSave, this.config.applicationId);
  const hasLiveQuery = this.config.liveQueryController.hasLiveQuery(this.className);
  if (!hasAfterSaveHook && !hasLiveQuery) {
    return Promise.resolve();
  }

  var extraData = { className: this.className };
  if (this.query && this.query.objectId) {
    extraData.objectId = this.query.objectId;
  }

  // Build the original object, we only do this for a update write.
  let originalObject;
  if (this.query && this.query.objectId) {
    originalObject = triggers.inflate(extraData, this.originalData);
  }

  // Build the inflated object, different from beforeSave, originalData is not empty
  // since developers can change data in the beforeSave.
  const updatedObject = this.buildUpdatedObject(extraData);
  updatedObject._handleSaveResponse(this.response.response, this.response.status || 200);

  // Notifiy LiveQueryServer if possible
  this.config.liveQueryController.onAfterSave(updatedObject.className, updatedObject, originalObject);

  // Run afterSave trigger
  return triggers.maybeRunTrigger(triggers.Types.afterSave, this.auth, updatedObject, originalObject, this.config, this.context).catch(function (err) {
    _logger2.default.warn('afterSave caught an error', err);
  });
};

// A helper to figure out what location this operation happens at.
RestWrite.prototype.location = function () {
  var middle = this.className === '_User' ? '/users/' : '/classes/' + this.className + '/';
  return this.config.mount + middle + this.data.objectId;
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
  }, deepcopy(this.data));
  return Parse._decode(undefined, data);
};

// Returns an updated copy of the object
RestWrite.prototype.buildUpdatedObject = function (extraData) {
  const updatedObject = triggers.inflate(extraData, this.originalData);
  Object.keys(this.data).reduce(function (data, key) {
    if (key.indexOf(".") > 0) {
      // subdocument key with dot notation ('x.y':v => 'x':{'y':v})
      const splittedKey = key.split(".");
      const parentProp = splittedKey[0];
      let parentVal = updatedObject.get(parentProp);
      if (typeof parentVal !== 'object') {
        parentVal = {};
      }
      parentVal[splittedKey[1]] = data[key];
      updatedObject.set(parentProp, parentVal);
      delete data[key];
    }
    return data;
  }, deepcopy(this.data));

  updatedObject.set(this.sanitizedData());
  return updatedObject;
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

RestWrite.prototype._updateResponseWithData = function (response, data) {
  if (_lodash2.default.isEmpty(this.storage.fieldsChangedByTrigger)) {
    return response;
  }
  const clientSupportsDelete = ClientSDK.supportsForwardDelete(this.clientSDK);
  this.storage.fieldsChangedByTrigger.forEach(fieldName => {
    const dataValue = data[fieldName];

    if (!response.hasOwnProperty(fieldName)) {
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

exports.default = RestWrite;

module.exports = RestWrite;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0V3JpdGUuanMiXSwibmFtZXMiOlsiU2NoZW1hQ29udHJvbGxlciIsInJlcXVpcmUiLCJkZWVwY29weSIsIkF1dGgiLCJjcnlwdG9VdGlscyIsInBhc3N3b3JkQ3J5cHRvIiwiUGFyc2UiLCJ0cmlnZ2VycyIsIkNsaWVudFNESyIsIlJlc3RXcml0ZSIsImNvbmZpZyIsImF1dGgiLCJjbGFzc05hbWUiLCJxdWVyeSIsImRhdGEiLCJvcmlnaW5hbERhdGEiLCJjbGllbnRTREsiLCJpc1JlYWRPbmx5IiwiRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwic3RvcmFnZSIsInJ1bk9wdGlvbnMiLCJjb250ZXh0Iiwib2JqZWN0SWQiLCJJTlZBTElEX0tFWV9OQU1FIiwicmVzcG9uc2UiLCJ1cGRhdGVkQXQiLCJfZW5jb2RlIiwiRGF0ZSIsImlzbyIsInByb3RvdHlwZSIsImV4ZWN1dGUiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsImhhbmRsZUluc3RhbGxhdGlvbiIsImhhbmRsZVNlc3Npb24iLCJ2YWxpZGF0ZUF1dGhEYXRhIiwicnVuQmVmb3JlVHJpZ2dlciIsInZhbGlkYXRlU2NoZW1hIiwic2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCIsInRyYW5zZm9ybVVzZXIiLCJleHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyIsImRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMiLCJydW5EYXRhYmFzZU9wZXJhdGlvbiIsImNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkIiwiaGFuZGxlRm9sbG93dXAiLCJydW5BZnRlclRyaWdnZXIiLCJjbGVhblVzZXJBdXRoRGF0YSIsImlzTWFzdGVyIiwiYWNsIiwidXNlciIsImdldFVzZXJSb2xlcyIsInJvbGVzIiwiY29uY2F0IiwiaWQiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwiaW5kZXhPZiIsImRhdGFiYXNlIiwibG9hZFNjaGVtYSIsInNjaGVtYUNvbnRyb2xsZXIiLCJoYXNDbGFzcyIsInZhbGlkYXRlT2JqZWN0IiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYmVmb3JlU2F2ZSIsImFwcGxpY2F0aW9uSWQiLCJleHRyYURhdGEiLCJvcmlnaW5hbE9iamVjdCIsInVwZGF0ZWRPYmplY3QiLCJidWlsZFVwZGF0ZWRPYmplY3QiLCJpbmZsYXRlIiwibWF5YmVSdW5UcmlnZ2VyIiwib2JqZWN0IiwiZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciIsIl8iLCJyZWR1Y2UiLCJyZXN1bHQiLCJ2YWx1ZSIsImtleSIsImlzRXF1YWwiLCJwdXNoIiwiY3JlYXRlZEF0IiwibmV3T2JqZWN0SWQiLCJvYmplY3RJZFNpemUiLCJhdXRoRGF0YSIsInVzZXJuYW1lIiwiaXNFbXB0eSIsIlVTRVJOQU1FX01JU1NJTkciLCJwYXNzd29yZCIsIlBBU1NXT1JEX01JU1NJTkciLCJPYmplY3QiLCJrZXlzIiwibGVuZ3RoIiwicHJvdmlkZXJzIiwiY2FuSGFuZGxlQXV0aERhdGEiLCJjYW5IYW5kbGUiLCJwcm92aWRlciIsInByb3ZpZGVyQXV0aERhdGEiLCJoYXNUb2tlbiIsImhhbmRsZUF1dGhEYXRhIiwiVU5TVVBQT1JURURfU0VSVklDRSIsImhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiIsInZhbGlkYXRpb25zIiwibWFwIiwiYXV0aERhdGFNYW5hZ2VyIiwiZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIiLCJhbGwiLCJmaW5kVXNlcnNXaXRoQXV0aERhdGEiLCJtZW1vIiwicXVlcnlLZXkiLCJmaWx0ZXIiLCJxIiwiZmluZFByb21pc2UiLCJmaW5kIiwiZmlsdGVyZWRPYmplY3RzQnlBQ0wiLCJvYmplY3RzIiwiQUNMIiwicmVzdWx0cyIsInIiLCJBQ0NPVU5UX0FMUkVBRFlfTElOS0VEIiwiam9pbiIsInVzZXJSZXN1bHQiLCJtdXRhdGVkQXV0aERhdGEiLCJmb3JFYWNoIiwicHJvdmlkZXJEYXRhIiwidXNlckF1dGhEYXRhIiwiaGFzTXV0YXRlZEF1dGhEYXRhIiwidXNlcklkIiwibG9jYXRpb24iLCJ1cGRhdGUiLCJwcm9taXNlIiwiZXJyb3IiLCJSZXN0UXVlcnkiLCJtYXN0ZXIiLCJfX3R5cGUiLCJzZXNzaW9uIiwiY2FjaGVDb250cm9sbGVyIiwiZGVsIiwic2Vzc2lvblRva2VuIiwidW5kZWZpbmVkIiwiX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kiLCJoYXNoIiwiaGFzaGVkUGFzc3dvcmQiLCJfaGFzaGVkX3Bhc3N3b3JkIiwiX3ZhbGlkYXRlVXNlck5hbWUiLCJfdmFsaWRhdGVFbWFpbCIsInJhbmRvbVN0cmluZyIsInJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lIiwibGltaXQiLCJVU0VSTkFNRV9UQUtFTiIsImVtYWlsIiwiX19vcCIsIm1hdGNoIiwicmVqZWN0IiwiSU5WQUxJRF9FTUFJTF9BRERSRVNTIiwiRU1BSUxfVEFLRU4iLCJ1c2VyQ29udHJvbGxlciIsInNldEVtYWlsVmVyaWZ5VG9rZW4iLCJwYXNzd29yZFBvbGljeSIsIl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzIiwiX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5IiwicG9saWN5RXJyb3IiLCJwYXR0ZXJuVmFsaWRhdG9yIiwidmFsaWRhdG9yQ2FsbGJhY2siLCJWQUxJREFUSU9OX0VSUk9SIiwiZG9Ob3RBbGxvd1VzZXJuYW1lIiwibWF4UGFzc3dvcmRIaXN0b3J5Iiwib2xkUGFzc3dvcmRzIiwiX3Bhc3N3b3JkX2hpc3RvcnkiLCJ0YWtlIiwibmV3UGFzc3dvcmQiLCJwcm9taXNlcyIsImNvbXBhcmUiLCJjYXRjaCIsImVyciIsInByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwiLCJ2ZXJpZnlVc2VyRW1haWxzIiwiY3JlYXRlU2Vzc2lvblRva2VuIiwiaW5zdGFsbGF0aW9uSWQiLCJzZXNzaW9uRGF0YSIsImNyZWF0ZVNlc3Npb24iLCJjcmVhdGVkV2l0aCIsImRlc3Ryb3kiLCJyZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0Iiwic2Vzc2lvblF1ZXJ5IiwiYmluZCIsInNlbmRWZXJpZmljYXRpb25FbWFpbCIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsImFkZGl0aW9uYWxTZXNzaW9uRGF0YSIsImFjdGlvbiIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsInN0YXR1cyIsImRldmljZVRva2VuIiwidG9Mb3dlckNhc2UiLCJkZXZpY2VUeXBlIiwiaWRNYXRjaCIsIm9iamVjdElkTWF0Y2giLCJpbnN0YWxsYXRpb25JZE1hdGNoIiwiZGV2aWNlVG9rZW5NYXRjaGVzIiwib3JRdWVyaWVzIiwiT0JKRUNUX05PVF9GT1VORCIsImRlbFF1ZXJ5IiwiYXBwSWRlbnRpZmllciIsImNvZGUiLCJvYmpJZCIsImZpbGVzQ29udHJvbGxlciIsImV4cGFuZEZpbGVzSW5PYmplY3QiLCJyb2xlIiwiY2xlYXIiLCJpc1VuYXV0aGVudGljYXRlZCIsIlNFU1NJT05fTUlTU0lORyIsImRvd25sb2FkIiwiZG93bmxvYWROYW1lIiwibmFtZSIsIklOVkFMSURfQUNMIiwicmVhZCIsIndyaXRlIiwibWF4UGFzc3dvcmRBZ2UiLCJfcGFzc3dvcmRfY2hhbmdlZF9hdCIsImRlZmVyIiwic2hpZnQiLCJfdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSIsImNyZWF0ZSIsIkRVUExJQ0FURV9WQUxVRSIsInVzZXJJbmZvIiwiZHVwbGljYXRlZF9maWVsZCIsImhhc0FmdGVyU2F2ZUhvb2siLCJhZnRlclNhdmUiLCJoYXNMaXZlUXVlcnkiLCJsaXZlUXVlcnlDb250cm9sbGVyIiwiX2hhbmRsZVNhdmVSZXNwb25zZSIsIm9uQWZ0ZXJTYXZlIiwibG9nZ2VyIiwid2FybiIsIm1pZGRsZSIsIm1vdW50Iiwic2FuaXRpemVkRGF0YSIsInRlc3QiLCJfZGVjb2RlIiwic3BsaXR0ZWRLZXkiLCJzcGxpdCIsInBhcmVudFByb3AiLCJwYXJlbnRWYWwiLCJnZXQiLCJzZXQiLCJjbGllbnRTdXBwb3J0c0RlbGV0ZSIsInN1cHBvcnRzRm9yd2FyZERlbGV0ZSIsImZpZWxkTmFtZSIsImRhdGFWYWx1ZSIsImhhc093blByb3BlcnR5IiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBYUE7Ozs7QUFDQTs7OztBQUNBOzs7Ozs7QUFmQTtBQUNBO0FBQ0E7O0FBRUEsSUFBSUEsbUJBQW1CQyxRQUFRLGdDQUFSLENBQXZCO0FBQ0EsSUFBSUMsV0FBV0QsUUFBUSxVQUFSLENBQWY7O0FBRUEsTUFBTUUsT0FBT0YsUUFBUSxRQUFSLENBQWI7QUFDQSxJQUFJRyxjQUFjSCxRQUFRLGVBQVIsQ0FBbEI7QUFDQSxJQUFJSSxpQkFBaUJKLFFBQVEsWUFBUixDQUFyQjtBQUNBLElBQUlLLFFBQVFMLFFBQVEsWUFBUixDQUFaO0FBQ0EsSUFBSU0sV0FBV04sUUFBUSxZQUFSLENBQWY7QUFDQSxJQUFJTyxZQUFZUCxRQUFRLGFBQVIsQ0FBaEI7OztBQUtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFNBQVNRLFNBQVQsQ0FBbUJDLE1BQW5CLEVBQTJCQyxJQUEzQixFQUFpQ0MsU0FBakMsRUFBNENDLEtBQTVDLEVBQW1EQyxJQUFuRCxFQUF5REMsWUFBekQsRUFBdUVDLFNBQXZFLEVBQWtGO0FBQ2hGLE1BQUlMLEtBQUtNLFVBQVQsRUFBcUI7QUFDbkIsVUFBTSxJQUFJWCxNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlDLG1CQUE1QixFQUFpRCwrREFBakQsQ0FBTjtBQUNEO0FBQ0QsT0FBS1QsTUFBTCxHQUFjQSxNQUFkO0FBQ0EsT0FBS0MsSUFBTCxHQUFZQSxJQUFaO0FBQ0EsT0FBS0MsU0FBTCxHQUFpQkEsU0FBakI7QUFDQSxPQUFLSSxTQUFMLEdBQWlCQSxTQUFqQjtBQUNBLE9BQUtJLE9BQUwsR0FBZSxFQUFmO0FBQ0EsT0FBS0MsVUFBTCxHQUFrQixFQUFsQjtBQUNBLE9BQUtDLE9BQUwsR0FBZSxFQUFmO0FBQ0EsTUFBSSxDQUFDVCxLQUFELElBQVVDLEtBQUtTLFFBQW5CLEVBQTZCO0FBQzNCLFVBQU0sSUFBSWpCLE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWU0sZ0JBQTVCLEVBQThDLG9DQUE5QyxDQUFOO0FBQ0Q7O0FBRUQ7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE9BQUtDLFFBQUwsR0FBZ0IsSUFBaEI7O0FBRUE7QUFDQTtBQUNBLE9BQUtaLEtBQUwsR0FBYVgsU0FBU1csS0FBVCxDQUFiO0FBQ0EsT0FBS0MsSUFBTCxHQUFZWixTQUFTWSxJQUFULENBQVo7QUFDQTtBQUNBLE9BQUtDLFlBQUwsR0FBb0JBLFlBQXBCOztBQUVBO0FBQ0EsT0FBS1csU0FBTCxHQUFpQnBCLE1BQU1xQixPQUFOLENBQWMsSUFBSUMsSUFBSixFQUFkLEVBQTBCQyxHQUEzQztBQUNEOztBQUVEO0FBQ0E7QUFDQTtBQUNBO0FBQ0FwQixVQUFVcUIsU0FBVixDQUFvQkMsT0FBcEIsR0FBOEIsWUFBVztBQUN2QyxTQUFPQyxRQUFRQyxPQUFSLEdBQWtCQyxJQUFsQixDQUF1QixNQUFNO0FBQ2xDLFdBQU8sS0FBS0MsaUJBQUwsRUFBUDtBQUNELEdBRk0sRUFFSkQsSUFGSSxDQUVDLE1BQU07QUFDWixXQUFPLEtBQUtFLDJCQUFMLEVBQVA7QUFDRCxHQUpNLEVBSUpGLElBSkksQ0FJQyxNQUFNO0FBQ1osV0FBTyxLQUFLRyxrQkFBTCxFQUFQO0FBQ0QsR0FOTSxFQU1KSCxJQU5JLENBTUMsTUFBTTtBQUNaLFdBQU8sS0FBS0ksYUFBTCxFQUFQO0FBQ0QsR0FSTSxFQVFKSixJQVJJLENBUUMsTUFBTTtBQUNaLFdBQU8sS0FBS0ssZ0JBQUwsRUFBUDtBQUNELEdBVk0sRUFVSkwsSUFWSSxDQVVDLE1BQU07QUFDWixXQUFPLEtBQUtNLGdCQUFMLEVBQVA7QUFDRCxHQVpNLEVBWUpOLElBWkksQ0FZQyxNQUFNO0FBQ1osV0FBTyxLQUFLTyxjQUFMLEVBQVA7QUFDRCxHQWRNLEVBY0pQLElBZEksQ0FjQyxNQUFNO0FBQ1osV0FBTyxLQUFLUSx5QkFBTCxFQUFQO0FBQ0QsR0FoQk0sRUFnQkpSLElBaEJJLENBZ0JDLE1BQU07QUFDWixXQUFPLEtBQUtTLGFBQUwsRUFBUDtBQUNELEdBbEJNLEVBa0JKVCxJQWxCSSxDQWtCQyxNQUFNO0FBQ1osV0FBTyxLQUFLVSw2QkFBTCxFQUFQO0FBQ0QsR0FwQk0sRUFvQkpWLElBcEJJLENBb0JDLE1BQU07QUFDWixXQUFPLEtBQUtXLHlCQUFMLEVBQVA7QUFDRCxHQXRCTSxFQXNCSlgsSUF0QkksQ0FzQkMsTUFBTTtBQUNaLFdBQU8sS0FBS1ksb0JBQUwsRUFBUDtBQUNELEdBeEJNLEVBd0JKWixJQXhCSSxDQXdCQyxNQUFNO0FBQ1osV0FBTyxLQUFLYSwwQkFBTCxFQUFQO0FBQ0QsR0ExQk0sRUEwQkpiLElBMUJJLENBMEJDLE1BQU07QUFDWixXQUFPLEtBQUtjLGNBQUwsRUFBUDtBQUNELEdBNUJNLEVBNEJKZCxJQTVCSSxDQTRCQyxNQUFNO0FBQ1osV0FBTyxLQUFLZSxlQUFMLEVBQVA7QUFDRCxHQTlCTSxFQThCSmYsSUE5QkksQ0E4QkMsTUFBTTtBQUNaLFdBQU8sS0FBS2dCLGlCQUFMLEVBQVA7QUFDRCxHQWhDTSxFQWdDSmhCLElBaENJLENBZ0NDLE1BQU07QUFDWixXQUFPLEtBQUtULFFBQVo7QUFDRCxHQWxDTSxDQUFQO0FBbUNELENBcENEOztBQXNDQTtBQUNBaEIsVUFBVXFCLFNBQVYsQ0FBb0JLLGlCQUFwQixHQUF3QyxZQUFXO0FBQ2pELE1BQUksS0FBS3hCLElBQUwsQ0FBVXdDLFFBQWQsRUFBd0I7QUFDdEIsV0FBT25CLFFBQVFDLE9BQVIsRUFBUDtBQUNEOztBQUVELE9BQUtaLFVBQUwsQ0FBZ0IrQixHQUFoQixHQUFzQixDQUFDLEdBQUQsQ0FBdEI7O0FBRUEsTUFBSSxLQUFLekMsSUFBTCxDQUFVMEMsSUFBZCxFQUFvQjtBQUNsQixXQUFPLEtBQUsxQyxJQUFMLENBQVUyQyxZQUFWLEdBQXlCcEIsSUFBekIsQ0FBK0JxQixLQUFELElBQVc7QUFDOUMsV0FBS2xDLFVBQUwsQ0FBZ0IrQixHQUFoQixHQUFzQixLQUFLL0IsVUFBTCxDQUFnQitCLEdBQWhCLENBQW9CSSxNQUFwQixDQUEyQkQsS0FBM0IsRUFBa0MsQ0FBQyxLQUFLNUMsSUFBTCxDQUFVMEMsSUFBVixDQUFlSSxFQUFoQixDQUFsQyxDQUF0QjtBQUNBO0FBQ0QsS0FITSxDQUFQO0FBSUQsR0FMRCxNQUtPO0FBQ0wsV0FBT3pCLFFBQVFDLE9BQVIsRUFBUDtBQUNEO0FBQ0YsQ0FmRDs7QUFpQkE7QUFDQXhCLFVBQVVxQixTQUFWLENBQW9CTSwyQkFBcEIsR0FBa0QsWUFBVztBQUMzRCxNQUFJLEtBQUsxQixNQUFMLENBQVlnRCx3QkFBWixLQUF5QyxLQUF6QyxJQUFrRCxDQUFDLEtBQUsvQyxJQUFMLENBQVV3QyxRQUE3RCxJQUNHbkQsaUJBQWlCMkQsYUFBakIsQ0FBK0JDLE9BQS9CLENBQXVDLEtBQUtoRCxTQUE1QyxNQUEyRCxDQUFDLENBRG5FLEVBQ3NFO0FBQ3BFLFdBQU8sS0FBS0YsTUFBTCxDQUFZbUQsUUFBWixDQUFxQkMsVUFBckIsR0FDSjVCLElBREksQ0FDQzZCLG9CQUFvQkEsaUJBQWlCQyxRQUFqQixDQUEwQixLQUFLcEQsU0FBL0IsQ0FEckIsRUFFSnNCLElBRkksQ0FFQzhCLFlBQVk7QUFDaEIsVUFBSUEsYUFBYSxJQUFqQixFQUF1QjtBQUNyQixjQUFNLElBQUkxRCxNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlDLG1CQUE1QixFQUNKLHdDQUNvQixzQkFEcEIsR0FDNkMsS0FBS1AsU0FGOUMsQ0FBTjtBQUdEO0FBQ0YsS0FSSSxDQUFQO0FBU0QsR0FYRCxNQVdPO0FBQ0wsV0FBT29CLFFBQVFDLE9BQVIsRUFBUDtBQUNEO0FBQ0YsQ0FmRDs7QUFpQkE7QUFDQXhCLFVBQVVxQixTQUFWLENBQW9CVyxjQUFwQixHQUFxQyxZQUFXO0FBQzlDLFNBQU8sS0FBSy9CLE1BQUwsQ0FBWW1ELFFBQVosQ0FBcUJJLGNBQXJCLENBQW9DLEtBQUtyRCxTQUF6QyxFQUFvRCxLQUFLRSxJQUF6RCxFQUErRCxLQUFLRCxLQUFwRSxFQUEyRSxLQUFLUSxVQUFoRixDQUFQO0FBQ0QsQ0FGRDs7QUFJQTtBQUNBO0FBQ0FaLFVBQVVxQixTQUFWLENBQW9CVSxnQkFBcEIsR0FBdUMsWUFBVztBQUNoRCxNQUFJLEtBQUtmLFFBQVQsRUFBbUI7QUFDakI7QUFDRDs7QUFFRDtBQUNBLE1BQUksQ0FBQ2xCLFNBQVMyRCxhQUFULENBQXVCLEtBQUt0RCxTQUE1QixFQUF1Q0wsU0FBUzRELEtBQVQsQ0FBZUMsVUFBdEQsRUFBa0UsS0FBSzFELE1BQUwsQ0FBWTJELGFBQTlFLENBQUwsRUFBbUc7QUFDakcsV0FBT3JDLFFBQVFDLE9BQVIsRUFBUDtBQUNEOztBQUVEO0FBQ0EsTUFBSXFDLFlBQVksRUFBQzFELFdBQVcsS0FBS0EsU0FBakIsRUFBaEI7QUFDQSxNQUFJLEtBQUtDLEtBQUwsSUFBYyxLQUFLQSxLQUFMLENBQVdVLFFBQTdCLEVBQXVDO0FBQ3JDK0MsY0FBVS9DLFFBQVYsR0FBcUIsS0FBS1YsS0FBTCxDQUFXVSxRQUFoQztBQUNEOztBQUVELE1BQUlnRCxpQkFBaUIsSUFBckI7QUFDQSxRQUFNQyxnQkFBZ0IsS0FBS0Msa0JBQUwsQ0FBd0JILFNBQXhCLENBQXRCO0FBQ0EsTUFBSSxLQUFLekQsS0FBTCxJQUFjLEtBQUtBLEtBQUwsQ0FBV1UsUUFBN0IsRUFBdUM7QUFDckM7QUFDQWdELHFCQUFpQmhFLFNBQVNtRSxPQUFULENBQWlCSixTQUFqQixFQUE0QixLQUFLdkQsWUFBakMsQ0FBakI7QUFDRDs7QUFFRCxTQUFPaUIsUUFBUUMsT0FBUixHQUFrQkMsSUFBbEIsQ0FBdUIsTUFBTTtBQUNsQyxXQUFPM0IsU0FBU29FLGVBQVQsQ0FBeUJwRSxTQUFTNEQsS0FBVCxDQUFlQyxVQUF4QyxFQUFvRCxLQUFLekQsSUFBekQsRUFBK0Q2RCxhQUEvRCxFQUE4RUQsY0FBOUUsRUFBOEYsS0FBSzdELE1BQW5HLEVBQTJHLEtBQUtZLE9BQWhILENBQVA7QUFDRCxHQUZNLEVBRUpZLElBRkksQ0FFRVQsUUFBRCxJQUFjO0FBQ3BCLFFBQUlBLFlBQVlBLFNBQVNtRCxNQUF6QixFQUFpQztBQUMvQixXQUFLeEQsT0FBTCxDQUFheUQsc0JBQWIsR0FBc0NDLGlCQUFFQyxNQUFGLENBQVN0RCxTQUFTbUQsTUFBbEIsRUFBMEIsQ0FBQ0ksTUFBRCxFQUFTQyxLQUFULEVBQWdCQyxHQUFoQixLQUF3QjtBQUN0RixZQUFJLENBQUNKLGlCQUFFSyxPQUFGLENBQVUsS0FBS3JFLElBQUwsQ0FBVW9FLEdBQVYsQ0FBVixFQUEwQkQsS0FBMUIsQ0FBTCxFQUF1QztBQUNyQ0QsaUJBQU9JLElBQVAsQ0FBWUYsR0FBWjtBQUNEO0FBQ0QsZUFBT0YsTUFBUDtBQUNELE9BTHFDLEVBS25DLEVBTG1DLENBQXRDO0FBTUEsV0FBS2xFLElBQUwsR0FBWVcsU0FBU21ELE1BQXJCO0FBQ0E7QUFDQSxVQUFJLEtBQUsvRCxLQUFMLElBQWMsS0FBS0EsS0FBTCxDQUFXVSxRQUE3QixFQUF1QztBQUNyQyxlQUFPLEtBQUtULElBQUwsQ0FBVVMsUUFBakI7QUFDRDtBQUNGO0FBQ0YsR0FoQk0sQ0FBUDtBQWlCRCxDQXhDRDs7QUEwQ0FkLFVBQVVxQixTQUFWLENBQW9CWSx5QkFBcEIsR0FBZ0QsWUFBVztBQUN6RCxNQUFJLEtBQUs1QixJQUFULEVBQWU7QUFDYjtBQUNBLFNBQUtBLElBQUwsQ0FBVVksU0FBVixHQUFzQixLQUFLQSxTQUEzQjtBQUNBLFFBQUksQ0FBQyxLQUFLYixLQUFWLEVBQWlCO0FBQ2YsV0FBS0MsSUFBTCxDQUFVdUUsU0FBVixHQUFzQixLQUFLM0QsU0FBM0I7O0FBRUE7QUFDQSxVQUFJLENBQUMsS0FBS1osSUFBTCxDQUFVUyxRQUFmLEVBQXlCO0FBQ3ZCLGFBQUtULElBQUwsQ0FBVVMsUUFBVixHQUFxQm5CLFlBQVlrRixXQUFaLENBQXdCLEtBQUs1RSxNQUFMLENBQVk2RSxZQUFwQyxDQUFyQjtBQUNEO0FBQ0Y7QUFDRjtBQUNELFNBQU92RCxRQUFRQyxPQUFSLEVBQVA7QUFDRCxDQWREOztBQWdCQTtBQUNBO0FBQ0E7QUFDQXhCLFVBQVVxQixTQUFWLENBQW9CUyxnQkFBcEIsR0FBdUMsWUFBVztBQUNoRCxNQUFJLEtBQUszQixTQUFMLEtBQW1CLE9BQXZCLEVBQWdDO0FBQzlCO0FBQ0Q7O0FBRUQsTUFBSSxDQUFDLEtBQUtDLEtBQU4sSUFBZSxDQUFDLEtBQUtDLElBQUwsQ0FBVTBFLFFBQTlCLEVBQXdDO0FBQ3RDLFFBQUksT0FBTyxLQUFLMUUsSUFBTCxDQUFVMkUsUUFBakIsS0FBOEIsUUFBOUIsSUFBMENYLGlCQUFFWSxPQUFGLENBQVUsS0FBSzVFLElBQUwsQ0FBVTJFLFFBQXBCLENBQTlDLEVBQTZFO0FBQzNFLFlBQU0sSUFBSW5GLE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWXlFLGdCQUE1QixFQUNKLHlCQURJLENBQU47QUFFRDtBQUNELFFBQUksT0FBTyxLQUFLN0UsSUFBTCxDQUFVOEUsUUFBakIsS0FBOEIsUUFBOUIsSUFBMENkLGlCQUFFWSxPQUFGLENBQVUsS0FBSzVFLElBQUwsQ0FBVThFLFFBQXBCLENBQTlDLEVBQTZFO0FBQzNFLFlBQU0sSUFBSXRGLE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWTJFLGdCQUE1QixFQUNKLHNCQURJLENBQU47QUFFRDtBQUNGOztBQUVELE1BQUksQ0FBQyxLQUFLL0UsSUFBTCxDQUFVMEUsUUFBWCxJQUF1QixDQUFDTSxPQUFPQyxJQUFQLENBQVksS0FBS2pGLElBQUwsQ0FBVTBFLFFBQXRCLEVBQWdDUSxNQUE1RCxFQUFvRTtBQUNsRTtBQUNEOztBQUVELE1BQUlSLFdBQVcsS0FBSzFFLElBQUwsQ0FBVTBFLFFBQXpCO0FBQ0EsTUFBSVMsWUFBWUgsT0FBT0MsSUFBUCxDQUFZUCxRQUFaLENBQWhCO0FBQ0EsTUFBSVMsVUFBVUQsTUFBVixHQUFtQixDQUF2QixFQUEwQjtBQUN4QixVQUFNRSxvQkFBb0JELFVBQVVsQixNQUFWLENBQWlCLENBQUNvQixTQUFELEVBQVlDLFFBQVosS0FBeUI7QUFDbEUsVUFBSUMsbUJBQW1CYixTQUFTWSxRQUFULENBQXZCO0FBQ0EsVUFBSUUsV0FBWUQsb0JBQW9CQSxpQkFBaUI1QyxFQUFyRDtBQUNBLGFBQU8wQyxjQUFjRyxZQUFZRCxvQkFBb0IsSUFBOUMsQ0FBUDtBQUNELEtBSnlCLEVBSXZCLElBSnVCLENBQTFCO0FBS0EsUUFBSUgsaUJBQUosRUFBdUI7QUFDckIsYUFBTyxLQUFLSyxjQUFMLENBQW9CZixRQUFwQixDQUFQO0FBQ0Q7QUFDRjtBQUNELFFBQU0sSUFBSWxGLE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWXNGLG1CQUE1QixFQUNKLDRDQURJLENBQU47QUFFRCxDQWxDRDs7QUFvQ0EvRixVQUFVcUIsU0FBVixDQUFvQjJFLHdCQUFwQixHQUErQyxVQUFTakIsUUFBVCxFQUFtQjtBQUNoRSxRQUFNa0IsY0FBY1osT0FBT0MsSUFBUCxDQUFZUCxRQUFaLEVBQXNCbUIsR0FBdEIsQ0FBMkJQLFFBQUQsSUFBYztBQUMxRCxRQUFJWixTQUFTWSxRQUFULE1BQXVCLElBQTNCLEVBQWlDO0FBQy9CLGFBQU9wRSxRQUFRQyxPQUFSLEVBQVA7QUFDRDtBQUNELFVBQU1NLG1CQUFtQixLQUFLN0IsTUFBTCxDQUFZa0csZUFBWixDQUE0QkMsdUJBQTVCLENBQW9EVCxRQUFwRCxDQUF6QjtBQUNBLFFBQUksQ0FBQzdELGdCQUFMLEVBQXVCO0FBQ3JCLFlBQU0sSUFBSWpDLE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWXNGLG1CQUE1QixFQUNKLDRDQURJLENBQU47QUFFRDtBQUNELFdBQU9qRSxpQkFBaUJpRCxTQUFTWSxRQUFULENBQWpCLENBQVA7QUFDRCxHQVZtQixDQUFwQjtBQVdBLFNBQU9wRSxRQUFROEUsR0FBUixDQUFZSixXQUFaLENBQVA7QUFDRCxDQWJEOztBQWVBakcsVUFBVXFCLFNBQVYsQ0FBb0JpRixxQkFBcEIsR0FBNEMsVUFBU3ZCLFFBQVQsRUFBbUI7QUFDN0QsUUFBTVMsWUFBWUgsT0FBT0MsSUFBUCxDQUFZUCxRQUFaLENBQWxCO0FBQ0EsUUFBTTNFLFFBQVFvRixVQUFVbEIsTUFBVixDQUFpQixDQUFDaUMsSUFBRCxFQUFPWixRQUFQLEtBQW9CO0FBQ2pELFFBQUksQ0FBQ1osU0FBU1ksUUFBVCxDQUFMLEVBQXlCO0FBQ3ZCLGFBQU9ZLElBQVA7QUFDRDtBQUNELFVBQU1DLFdBQVksWUFBV2IsUUFBUyxLQUF0QztBQUNBLFVBQU12RixRQUFRLEVBQWQ7QUFDQUEsVUFBTW9HLFFBQU4sSUFBa0J6QixTQUFTWSxRQUFULEVBQW1CM0MsRUFBckM7QUFDQXVELFNBQUs1QixJQUFMLENBQVV2RSxLQUFWO0FBQ0EsV0FBT21HLElBQVA7QUFDRCxHQVRhLEVBU1gsRUFUVyxFQVNQRSxNQVRPLENBU0NDLENBQUQsSUFBTztBQUNuQixXQUFPLE9BQU9BLENBQVAsS0FBYSxXQUFwQjtBQUNELEdBWGEsQ0FBZDs7QUFhQSxNQUFJQyxjQUFjcEYsUUFBUUMsT0FBUixDQUFnQixFQUFoQixDQUFsQjtBQUNBLE1BQUlwQixNQUFNbUYsTUFBTixHQUFlLENBQW5CLEVBQXNCO0FBQ3BCb0Isa0JBQWMsS0FBSzFHLE1BQUwsQ0FBWW1ELFFBQVosQ0FBcUJ3RCxJQUFyQixDQUNaLEtBQUt6RyxTQURPLEVBRVosRUFBQyxPQUFPQyxLQUFSLEVBRlksRUFFSSxFQUZKLENBQWQ7QUFHRDs7QUFFRCxTQUFPdUcsV0FBUDtBQUNELENBdkJEOztBQXlCQTNHLFVBQVVxQixTQUFWLENBQW9Cd0Ysb0JBQXBCLEdBQTJDLFVBQVNDLE9BQVQsRUFBa0I7QUFDM0QsTUFBSSxLQUFLNUcsSUFBTCxDQUFVd0MsUUFBZCxFQUF3QjtBQUN0QixXQUFPb0UsT0FBUDtBQUNEO0FBQ0QsU0FBT0EsUUFBUUwsTUFBUixDQUFnQnRDLE1BQUQsSUFBWTtBQUNoQyxRQUFJLENBQUNBLE9BQU80QyxHQUFaLEVBQWlCO0FBQ2YsYUFBTyxJQUFQLENBRGUsQ0FDRjtBQUNkO0FBQ0Q7QUFDQSxXQUFPNUMsT0FBTzRDLEdBQVAsSUFBYzFCLE9BQU9DLElBQVAsQ0FBWW5CLE9BQU80QyxHQUFuQixFQUF3QnhCLE1BQXhCLEdBQWlDLENBQXREO0FBQ0QsR0FOTSxDQUFQO0FBT0QsQ0FYRDs7QUFhQXZGLFVBQVVxQixTQUFWLENBQW9CeUUsY0FBcEIsR0FBcUMsVUFBU2YsUUFBVCxFQUFtQjtBQUN0RCxNQUFJaUMsT0FBSjtBQUNBLFNBQU8sS0FBS1YscUJBQUwsQ0FBMkJ2QixRQUEzQixFQUFxQ3RELElBQXJDLENBQTJDd0YsQ0FBRCxJQUFPO0FBQ3RERCxjQUFVLEtBQUtILG9CQUFMLENBQTBCSSxDQUExQixDQUFWO0FBQ0EsUUFBSUQsUUFBUXpCLE1BQVIsR0FBaUIsQ0FBckIsRUFBd0I7QUFDdEI7QUFDQSxZQUFNLElBQUkxRixNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVl5RyxzQkFBNUIsRUFDSiwyQkFESSxDQUFOO0FBRUQ7O0FBRUQsU0FBS3ZHLE9BQUwsQ0FBYSxjQUFiLElBQStCMEUsT0FBT0MsSUFBUCxDQUFZUCxRQUFaLEVBQXNCb0MsSUFBdEIsQ0FBMkIsR0FBM0IsQ0FBL0I7O0FBRUEsUUFBSUgsUUFBUXpCLE1BQVIsR0FBaUIsQ0FBckIsRUFBd0I7QUFDdEIsWUFBTTZCLGFBQWFKLFFBQVEsQ0FBUixDQUFuQjtBQUNBLFlBQU1LLGtCQUFrQixFQUF4QjtBQUNBaEMsYUFBT0MsSUFBUCxDQUFZUCxRQUFaLEVBQXNCdUMsT0FBdEIsQ0FBK0IzQixRQUFELElBQWM7QUFDMUMsY0FBTTRCLGVBQWV4QyxTQUFTWSxRQUFULENBQXJCO0FBQ0EsY0FBTTZCLGVBQWVKLFdBQVdyQyxRQUFYLENBQW9CWSxRQUFwQixDQUFyQjtBQUNBLFlBQUksQ0FBQ3RCLGlCQUFFSyxPQUFGLENBQVU2QyxZQUFWLEVBQXdCQyxZQUF4QixDQUFMLEVBQTRDO0FBQzFDSCwwQkFBZ0IxQixRQUFoQixJQUE0QjRCLFlBQTVCO0FBQ0Q7QUFDRixPQU5EO0FBT0EsWUFBTUUscUJBQXFCcEMsT0FBT0MsSUFBUCxDQUFZK0IsZUFBWixFQUE2QjlCLE1BQTdCLEtBQXdDLENBQW5FO0FBQ0EsVUFBSW1DLE1BQUo7QUFDQSxVQUFJLEtBQUt0SCxLQUFMLElBQWMsS0FBS0EsS0FBTCxDQUFXVSxRQUE3QixFQUF1QztBQUNyQzRHLGlCQUFTLEtBQUt0SCxLQUFMLENBQVdVLFFBQXBCO0FBQ0QsT0FGRCxNQUVPLElBQUksS0FBS1osSUFBTCxJQUFhLEtBQUtBLElBQUwsQ0FBVTBDLElBQXZCLElBQStCLEtBQUsxQyxJQUFMLENBQVUwQyxJQUFWLENBQWVJLEVBQWxELEVBQXNEO0FBQzNEMEUsaUJBQVMsS0FBS3hILElBQUwsQ0FBVTBDLElBQVYsQ0FBZUksRUFBeEI7QUFDRDtBQUNELFVBQUksQ0FBQzBFLE1BQUQsSUFBV0EsV0FBV04sV0FBV3RHLFFBQXJDLEVBQStDO0FBQUU7QUFDL0M7QUFDQTtBQUNBLGVBQU9rRyxRQUFRLENBQVIsRUFBVzdCLFFBQWxCOztBQUVBO0FBQ0EsYUFBSzlFLElBQUwsQ0FBVVMsUUFBVixHQUFxQnNHLFdBQVd0RyxRQUFoQzs7QUFFQSxZQUFJLENBQUMsS0FBS1YsS0FBTixJQUFlLENBQUMsS0FBS0EsS0FBTCxDQUFXVSxRQUEvQixFQUF5QztBQUFFO0FBQ3pDLGVBQUtFLFFBQUwsR0FBZ0I7QUFDZEEsc0JBQVVvRyxVQURJO0FBRWRPLHNCQUFVLEtBQUtBLFFBQUw7QUFGSSxXQUFoQjtBQUlEO0FBQ0Q7QUFDQSxZQUFJLENBQUNGLGtCQUFMLEVBQXlCO0FBQ3ZCO0FBQ0Q7QUFDRDtBQUNBO0FBQ0E7QUFDQTtBQUNBLGVBQU8sS0FBS3pCLHdCQUFMLENBQThCcUIsZUFBOUIsRUFBK0M1RixJQUEvQyxDQUFvRCxNQUFNO0FBQy9EO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsY0FBSSxLQUFLVCxRQUFULEVBQW1CO0FBQ2pCO0FBQ0FxRSxtQkFBT0MsSUFBUCxDQUFZK0IsZUFBWixFQUE2QkMsT0FBN0IsQ0FBc0MzQixRQUFELElBQWM7QUFDakQsbUJBQUszRSxRQUFMLENBQWNBLFFBQWQsQ0FBdUIrRCxRQUF2QixDQUFnQ1ksUUFBaEMsSUFBNEMwQixnQkFBZ0IxQixRQUFoQixDQUE1QztBQUNELGFBRkQ7QUFHQTtBQUNBO0FBQ0E7QUFDQSxtQkFBTyxLQUFLMUYsTUFBTCxDQUFZbUQsUUFBWixDQUFxQndFLE1BQXJCLENBQTRCLEtBQUt6SCxTQUFqQyxFQUE0QyxFQUFDVyxVQUFVLEtBQUtULElBQUwsQ0FBVVMsUUFBckIsRUFBNUMsRUFBNEUsRUFBQ2lFLFVBQVVzQyxlQUFYLEVBQTVFLEVBQXlHLEVBQXpHLENBQVA7QUFDRDtBQUNGLFNBZk0sQ0FBUDtBQWdCRCxPQXRDRCxNQXNDTyxJQUFJSyxNQUFKLEVBQVk7QUFDakI7QUFDQTtBQUNBLFlBQUlOLFdBQVd0RyxRQUFYLEtBQXdCNEcsTUFBNUIsRUFBb0M7QUFDbEMsZ0JBQU0sSUFBSTdILE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWXlHLHNCQUE1QixFQUNKLDJCQURJLENBQU47QUFFRDtBQUNEO0FBQ0EsWUFBSSxDQUFDTyxrQkFBTCxFQUF5QjtBQUN2QjtBQUNEO0FBQ0Y7QUFDRjtBQUNELFdBQU8sS0FBS3pCLHdCQUFMLENBQThCakIsUUFBOUIsQ0FBUDtBQUNELEdBL0VNLENBQVA7QUFnRkQsQ0FsRkQ7O0FBcUZBO0FBQ0EvRSxVQUFVcUIsU0FBVixDQUFvQmEsYUFBcEIsR0FBb0MsWUFBVztBQUM3QyxNQUFJMkYsVUFBVXRHLFFBQVFDLE9BQVIsRUFBZDs7QUFFQSxNQUFJLEtBQUtyQixTQUFMLEtBQW1CLE9BQXZCLEVBQWdDO0FBQzlCLFdBQU8wSCxPQUFQO0FBQ0Q7O0FBRUQsTUFBSSxDQUFDLEtBQUszSCxJQUFMLENBQVV3QyxRQUFYLElBQXVCLG1CQUFtQixLQUFLckMsSUFBbkQsRUFBeUQ7QUFDdkQsVUFBTXlILFFBQVMsK0RBQWY7QUFDQSxVQUFNLElBQUlqSSxNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlDLG1CQUE1QixFQUFpRG9ILEtBQWpELENBQU47QUFDRDs7QUFFRDtBQUNBLE1BQUksS0FBSzFILEtBQUwsSUFBYyxLQUFLVSxRQUFMLEVBQWxCLEVBQW1DO0FBQ2pDO0FBQ0E7QUFDQStHLGNBQVUsSUFBSUUsbUJBQUosQ0FBYyxLQUFLOUgsTUFBbkIsRUFBMkJQLEtBQUtzSSxNQUFMLENBQVksS0FBSy9ILE1BQWpCLENBQTNCLEVBQXFELFVBQXJELEVBQWlFO0FBQ3pFMkMsWUFBTTtBQUNKcUYsZ0JBQVEsU0FESjtBQUVKOUgsbUJBQVcsT0FGUDtBQUdKVyxrQkFBVSxLQUFLQSxRQUFMO0FBSE47QUFEbUUsS0FBakUsRUFNUFEsT0FOTyxHQU9QRyxJQVBPLENBT0Z1RixXQUFXO0FBQ2ZBLGNBQVFBLE9BQVIsQ0FBZ0JNLE9BQWhCLENBQXdCWSxXQUFXLEtBQUtqSSxNQUFMLENBQVlrSSxlQUFaLENBQTRCdkYsSUFBNUIsQ0FBaUN3RixHQUFqQyxDQUFxQ0YsUUFBUUcsWUFBN0MsQ0FBbkM7QUFDRCxLQVRPLENBQVY7QUFVRDs7QUFFRCxTQUFPUixRQUFRcEcsSUFBUixDQUFhLE1BQU07QUFDeEI7QUFDQSxRQUFJLEtBQUtwQixJQUFMLENBQVU4RSxRQUFWLEtBQXVCbUQsU0FBM0IsRUFBc0M7QUFBRTtBQUN0QyxhQUFPL0csUUFBUUMsT0FBUixFQUFQO0FBQ0Q7O0FBRUQsUUFBSSxLQUFLcEIsS0FBVCxFQUFnQjtBQUNkLFdBQUtPLE9BQUwsQ0FBYSxlQUFiLElBQWdDLElBQWhDO0FBQ0E7QUFDQSxVQUFJLENBQUMsS0FBS1QsSUFBTCxDQUFVd0MsUUFBZixFQUF5QjtBQUN2QixhQUFLL0IsT0FBTCxDQUFhLG9CQUFiLElBQXFDLElBQXJDO0FBQ0Q7QUFDRjs7QUFFRCxXQUFPLEtBQUs0SCx1QkFBTCxHQUErQjlHLElBQS9CLENBQW9DLE1BQU07QUFDL0MsYUFBTzdCLGVBQWU0SSxJQUFmLENBQW9CLEtBQUtuSSxJQUFMLENBQVU4RSxRQUE5QixFQUF3QzFELElBQXhDLENBQThDZ0gsY0FBRCxJQUFvQjtBQUN0RSxhQUFLcEksSUFBTCxDQUFVcUksZ0JBQVYsR0FBNkJELGNBQTdCO0FBQ0EsZUFBTyxLQUFLcEksSUFBTCxDQUFVOEUsUUFBakI7QUFDRCxPQUhNLENBQVA7QUFJRCxLQUxNLENBQVA7QUFPRCxHQXJCTSxFQXFCSjFELElBckJJLENBcUJDLE1BQU07QUFDWixXQUFPLEtBQUtrSCxpQkFBTCxFQUFQO0FBQ0QsR0F2Qk0sRUF1QkpsSCxJQXZCSSxDQXVCQyxNQUFNO0FBQ1osV0FBTyxLQUFLbUgsY0FBTCxFQUFQO0FBQ0QsR0F6Qk0sQ0FBUDtBQTBCRCxDQXRERDs7QUF3REE1SSxVQUFVcUIsU0FBVixDQUFvQnNILGlCQUFwQixHQUF3QyxZQUFZO0FBQ2xEO0FBQ0EsTUFBSSxDQUFDLEtBQUt0SSxJQUFMLENBQVUyRSxRQUFmLEVBQXlCO0FBQ3ZCLFFBQUksQ0FBQyxLQUFLNUUsS0FBVixFQUFpQjtBQUNmLFdBQUtDLElBQUwsQ0FBVTJFLFFBQVYsR0FBcUJyRixZQUFZa0osWUFBWixDQUF5QixFQUF6QixDQUFyQjtBQUNBLFdBQUtDLDBCQUFMLEdBQWtDLElBQWxDO0FBQ0Q7QUFDRCxXQUFPdkgsUUFBUUMsT0FBUixFQUFQO0FBQ0Q7QUFDRDtBQUNBO0FBQ0EsU0FBTyxLQUFLdkIsTUFBTCxDQUFZbUQsUUFBWixDQUFxQndELElBQXJCLENBQ0wsS0FBS3pHLFNBREEsRUFFTCxFQUFDNkUsVUFBVSxLQUFLM0UsSUFBTCxDQUFVMkUsUUFBckIsRUFBK0JsRSxVQUFVLEVBQUMsT0FBTyxLQUFLQSxRQUFMLEVBQVIsRUFBekMsRUFGSyxFQUdMLEVBQUNpSSxPQUFPLENBQVIsRUFISyxFQUlMdEgsSUFKSyxDQUlBdUYsV0FBVztBQUNoQixRQUFJQSxRQUFRekIsTUFBUixHQUFpQixDQUFyQixFQUF3QjtBQUN0QixZQUFNLElBQUkxRixNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVl1SSxjQUE1QixFQUE0QywyQ0FBNUMsQ0FBTjtBQUNEO0FBQ0Q7QUFDRCxHQVRNLENBQVA7QUFVRCxDQXJCRDs7QUF1QkFoSixVQUFVcUIsU0FBVixDQUFvQnVILGNBQXBCLEdBQXFDLFlBQVc7QUFDOUMsTUFBSSxDQUFDLEtBQUt2SSxJQUFMLENBQVU0SSxLQUFYLElBQW9CLEtBQUs1SSxJQUFMLENBQVU0SSxLQUFWLENBQWdCQyxJQUFoQixLQUF5QixRQUFqRCxFQUEyRDtBQUN6RCxXQUFPM0gsUUFBUUMsT0FBUixFQUFQO0FBQ0Q7QUFDRDtBQUNBLE1BQUksQ0FBQyxLQUFLbkIsSUFBTCxDQUFVNEksS0FBVixDQUFnQkUsS0FBaEIsQ0FBc0IsU0FBdEIsQ0FBTCxFQUF1QztBQUNyQyxXQUFPNUgsUUFBUTZILE1BQVIsQ0FBZSxJQUFJdkosTUFBTVksS0FBVixDQUFnQlosTUFBTVksS0FBTixDQUFZNEkscUJBQTVCLEVBQW1ELGtDQUFuRCxDQUFmLENBQVA7QUFDRDtBQUNEO0FBQ0EsU0FBTyxLQUFLcEosTUFBTCxDQUFZbUQsUUFBWixDQUFxQndELElBQXJCLENBQ0wsS0FBS3pHLFNBREEsRUFFTCxFQUFDOEksT0FBTyxLQUFLNUksSUFBTCxDQUFVNEksS0FBbEIsRUFBeUJuSSxVQUFVLEVBQUMsT0FBTyxLQUFLQSxRQUFMLEVBQVIsRUFBbkMsRUFGSyxFQUdMLEVBQUNpSSxPQUFPLENBQVIsRUFISyxFQUlMdEgsSUFKSyxDQUlBdUYsV0FBVztBQUNoQixRQUFJQSxRQUFRekIsTUFBUixHQUFpQixDQUFyQixFQUF3QjtBQUN0QixZQUFNLElBQUkxRixNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVk2SSxXQUE1QixFQUF5QyxnREFBekMsQ0FBTjtBQUNEO0FBQ0QsUUFDRSxDQUFDLEtBQUtqSixJQUFMLENBQVUwRSxRQUFYLElBQ0EsQ0FBQ00sT0FBT0MsSUFBUCxDQUFZLEtBQUtqRixJQUFMLENBQVUwRSxRQUF0QixFQUFnQ1EsTUFEakMsSUFFQUYsT0FBT0MsSUFBUCxDQUFZLEtBQUtqRixJQUFMLENBQVUwRSxRQUF0QixFQUFnQ1EsTUFBaEMsS0FBMkMsQ0FBM0MsSUFBZ0RGLE9BQU9DLElBQVAsQ0FBWSxLQUFLakYsSUFBTCxDQUFVMEUsUUFBdEIsRUFBZ0MsQ0FBaEMsTUFBdUMsV0FIekYsRUFJRTtBQUNBO0FBQ0EsV0FBS3BFLE9BQUwsQ0FBYSx1QkFBYixJQUF3QyxJQUF4QztBQUNBLFdBQUtWLE1BQUwsQ0FBWXNKLGNBQVosQ0FBMkJDLG1CQUEzQixDQUErQyxLQUFLbkosSUFBcEQ7QUFDRDtBQUNGLEdBakJNLENBQVA7QUFrQkQsQ0EzQkQ7O0FBNkJBTCxVQUFVcUIsU0FBVixDQUFvQmtILHVCQUFwQixHQUE4QyxZQUFXO0FBQ3ZELE1BQUksQ0FBQyxLQUFLdEksTUFBTCxDQUFZd0osY0FBakIsRUFDRSxPQUFPbEksUUFBUUMsT0FBUixFQUFQO0FBQ0YsU0FBTyxLQUFLa0ksNkJBQUwsR0FBcUNqSSxJQUFyQyxDQUEwQyxNQUFNO0FBQ3JELFdBQU8sS0FBS2tJLHdCQUFMLEVBQVA7QUFDRCxHQUZNLENBQVA7QUFHRCxDQU5EOztBQVNBM0osVUFBVXFCLFNBQVYsQ0FBb0JxSSw2QkFBcEIsR0FBb0QsWUFBVztBQUM3RDtBQUNBLFFBQU1FLGNBQWMsMERBQXBCOztBQUVBO0FBQ0EsTUFBSSxLQUFLM0osTUFBTCxDQUFZd0osY0FBWixDQUEyQkksZ0JBQTNCLElBQStDLENBQUMsS0FBSzVKLE1BQUwsQ0FBWXdKLGNBQVosQ0FBMkJJLGdCQUEzQixDQUE0QyxLQUFLeEosSUFBTCxDQUFVOEUsUUFBdEQsQ0FBaEQsSUFDRixLQUFLbEYsTUFBTCxDQUFZd0osY0FBWixDQUEyQkssaUJBQTNCLElBQWdELENBQUMsS0FBSzdKLE1BQUwsQ0FBWXdKLGNBQVosQ0FBMkJLLGlCQUEzQixDQUE2QyxLQUFLekosSUFBTCxDQUFVOEUsUUFBdkQsQ0FEbkQsRUFDcUg7QUFDbkgsV0FBTzVELFFBQVE2SCxNQUFSLENBQWUsSUFBSXZKLE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWXNKLGdCQUE1QixFQUE4Q0gsV0FBOUMsQ0FBZixDQUFQO0FBQ0Q7O0FBRUQ7QUFDQSxNQUFJLEtBQUszSixNQUFMLENBQVl3SixjQUFaLENBQTJCTyxrQkFBM0IsS0FBa0QsSUFBdEQsRUFBNEQ7QUFDMUQsUUFBSSxLQUFLM0osSUFBTCxDQUFVMkUsUUFBZCxFQUF3QjtBQUFFO0FBQ3hCLFVBQUksS0FBSzNFLElBQUwsQ0FBVThFLFFBQVYsQ0FBbUJoQyxPQUFuQixDQUEyQixLQUFLOUMsSUFBTCxDQUFVMkUsUUFBckMsS0FBa0QsQ0FBdEQsRUFDRSxPQUFPekQsUUFBUTZILE1BQVIsQ0FBZSxJQUFJdkosTUFBTVksS0FBVixDQUFnQlosTUFBTVksS0FBTixDQUFZc0osZ0JBQTVCLEVBQThDSCxXQUE5QyxDQUFmLENBQVA7QUFDSCxLQUhELE1BR087QUFBRTtBQUNQLGFBQU8sS0FBSzNKLE1BQUwsQ0FBWW1ELFFBQVosQ0FBcUJ3RCxJQUFyQixDQUEwQixPQUExQixFQUFtQyxFQUFDOUYsVUFBVSxLQUFLQSxRQUFMLEVBQVgsRUFBbkMsRUFDSlcsSUFESSxDQUNDdUYsV0FBVztBQUNmLFlBQUlBLFFBQVF6QixNQUFSLElBQWtCLENBQXRCLEVBQXlCO0FBQ3ZCLGdCQUFNK0MsU0FBTjtBQUNEO0FBQ0QsWUFBSSxLQUFLakksSUFBTCxDQUFVOEUsUUFBVixDQUFtQmhDLE9BQW5CLENBQTJCNkQsUUFBUSxDQUFSLEVBQVdoQyxRQUF0QyxLQUFtRCxDQUF2RCxFQUNFLE9BQU96RCxRQUFRNkgsTUFBUixDQUFlLElBQUl2SixNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlzSixnQkFBNUIsRUFBOENILFdBQTlDLENBQWYsQ0FBUDtBQUNGLGVBQU9ySSxRQUFRQyxPQUFSLEVBQVA7QUFDRCxPQVJJLENBQVA7QUFTRDtBQUNGO0FBQ0QsU0FBT0QsUUFBUUMsT0FBUixFQUFQO0FBQ0QsQ0E1QkQ7O0FBOEJBeEIsVUFBVXFCLFNBQVYsQ0FBb0JzSSx3QkFBcEIsR0FBK0MsWUFBVztBQUN4RDtBQUNBLE1BQUksS0FBS3ZKLEtBQUwsSUFBYyxLQUFLSCxNQUFMLENBQVl3SixjQUFaLENBQTJCUSxrQkFBN0MsRUFBaUU7QUFDL0QsV0FBTyxLQUFLaEssTUFBTCxDQUFZbUQsUUFBWixDQUFxQndELElBQXJCLENBQTBCLE9BQTFCLEVBQW1DLEVBQUM5RixVQUFVLEtBQUtBLFFBQUwsRUFBWCxFQUFuQyxFQUFnRSxFQUFDd0UsTUFBTSxDQUFDLG1CQUFELEVBQXNCLGtCQUF0QixDQUFQLEVBQWhFLEVBQ0o3RCxJQURJLENBQ0N1RixXQUFXO0FBQ2YsVUFBSUEsUUFBUXpCLE1BQVIsSUFBa0IsQ0FBdEIsRUFBeUI7QUFDdkIsY0FBTStDLFNBQU47QUFDRDtBQUNELFlBQU0xRixPQUFPb0UsUUFBUSxDQUFSLENBQWI7QUFDQSxVQUFJa0QsZUFBZSxFQUFuQjtBQUNBLFVBQUl0SCxLQUFLdUgsaUJBQVQsRUFDRUQsZUFBZTdGLGlCQUFFK0YsSUFBRixDQUFPeEgsS0FBS3VILGlCQUFaLEVBQStCLEtBQUtsSyxNQUFMLENBQVl3SixjQUFaLENBQTJCUSxrQkFBM0IsR0FBZ0QsQ0FBL0UsQ0FBZjtBQUNGQyxtQkFBYXZGLElBQWIsQ0FBa0IvQixLQUFLdUMsUUFBdkI7QUFDQSxZQUFNa0YsY0FBYyxLQUFLaEssSUFBTCxDQUFVOEUsUUFBOUI7QUFDQTtBQUNBLFlBQU1tRixXQUFXSixhQUFhaEUsR0FBYixDQUFpQixVQUFVc0MsSUFBVixFQUFnQjtBQUNoRCxlQUFPNUksZUFBZTJLLE9BQWYsQ0FBdUJGLFdBQXZCLEVBQW9DN0IsSUFBcEMsRUFBMEMvRyxJQUExQyxDQUFnRDhDLE1BQUQsSUFBWTtBQUNoRSxjQUFJQSxNQUFKLEVBQVk7QUFDVixtQkFBT2hELFFBQVE2SCxNQUFSLENBQWUsaUJBQWYsQ0FBUDtBQUNGLGlCQUFPN0gsUUFBUUMsT0FBUixFQUFQO0FBQ0QsU0FKTSxDQUFQO0FBS0QsT0FOZ0IsQ0FBakI7QUFPQTtBQUNBLGFBQU9ELFFBQVE4RSxHQUFSLENBQVlpRSxRQUFaLEVBQXNCN0ksSUFBdEIsQ0FBMkIsTUFBTTtBQUN0QyxlQUFPRixRQUFRQyxPQUFSLEVBQVA7QUFDRCxPQUZNLEVBRUpnSixLQUZJLENBRUVDLE9BQU87QUFDZCxZQUFJQSxRQUFRLGlCQUFaLEVBQStCO0FBQzdCLGlCQUFPbEosUUFBUTZILE1BQVIsQ0FBZSxJQUFJdkosTUFBTVksS0FBVixDQUFnQlosTUFBTVksS0FBTixDQUFZc0osZ0JBQTVCLEVBQStDLCtDQUE4QyxLQUFLOUosTUFBTCxDQUFZd0osY0FBWixDQUEyQlEsa0JBQW1CLGFBQTNJLENBQWYsQ0FBUDtBQUNGLGNBQU1RLEdBQU47QUFDRCxPQU5NLENBQVA7QUFPRCxLQTNCSSxDQUFQO0FBNEJEO0FBQ0QsU0FBT2xKLFFBQVFDLE9BQVIsRUFBUDtBQUNELENBakNEOztBQW1DQXhCLFVBQVVxQixTQUFWLENBQW9CaUIsMEJBQXBCLEdBQWlELFlBQVc7QUFDMUQsTUFBSSxLQUFLbkMsU0FBTCxLQUFtQixPQUF2QixFQUFnQztBQUM5QjtBQUNEO0FBQ0QsTUFBSSxLQUFLQyxLQUFULEVBQWdCO0FBQ2Q7QUFDRDtBQUNELE1BQUksQ0FBQyxLQUFLTyxPQUFMLENBQWEsY0FBYixDQUFELENBQThCO0FBQTlCLEtBQ0csS0FBS1YsTUFBTCxDQUFZeUssK0JBRGYsQ0FDK0M7QUFEL0MsS0FFRyxLQUFLekssTUFBTCxDQUFZMEssZ0JBRm5CLEVBRXFDO0FBQUU7QUFDckMsV0FEbUMsQ0FDM0I7QUFDVDtBQUNELFNBQU8sS0FBS0Msa0JBQUwsRUFBUDtBQUNELENBYkQ7O0FBZUE1SyxVQUFVcUIsU0FBVixDQUFvQnVKLGtCQUFwQixHQUF5QyxZQUFXO0FBQ2xEO0FBQ0E7QUFDQSxNQUFJLEtBQUsxSyxJQUFMLENBQVUySyxjQUFWLElBQTRCLEtBQUszSyxJQUFMLENBQVUySyxjQUFWLEtBQTZCLE9BQTdELEVBQXNFO0FBQ3BFO0FBQ0Q7O0FBRUQsUUFBTTtBQUNKQyxlQURJO0FBRUpDO0FBRkksTUFHRnJMLEtBQUtxTCxhQUFMLENBQW1CLEtBQUs5SyxNQUF4QixFQUFnQztBQUNsQ3lILFlBQVEsS0FBSzVHLFFBQUwsRUFEMEI7QUFFbENrSyxpQkFBYTtBQUNYLGdCQUFVLEtBQUtySyxPQUFMLENBQWEsY0FBYixJQUErQixPQUEvQixHQUF5QyxRQUR4QztBQUVYLHNCQUFnQixLQUFLQSxPQUFMLENBQWEsY0FBYixLQUFnQztBQUZyQyxLQUZxQjtBQU1sQ2tLLG9CQUFnQixLQUFLM0ssSUFBTCxDQUFVMks7QUFOUSxHQUFoQyxDQUhKOztBQVlBLE1BQUksS0FBSzdKLFFBQUwsSUFBaUIsS0FBS0EsUUFBTCxDQUFjQSxRQUFuQyxFQUE2QztBQUMzQyxTQUFLQSxRQUFMLENBQWNBLFFBQWQsQ0FBdUJxSCxZQUF2QixHQUFzQ3lDLFlBQVl6QyxZQUFsRDtBQUNEOztBQUVELFNBQU8wQyxlQUFQO0FBQ0QsQ0F4QkQ7O0FBMEJBL0ssVUFBVXFCLFNBQVYsQ0FBb0JlLHlCQUFwQixHQUFnRCxZQUFXO0FBQ3pEO0FBQ0EsTUFBSSxLQUFLakMsU0FBTCxJQUFrQixVQUFsQixJQUFnQyxLQUFLQyxLQUF6QyxFQUFnRDtBQUM5QztBQUNEO0FBQ0Q7QUFDQSxRQUFNO0FBQ0p3QyxRQURJO0FBRUppSSxrQkFGSTtBQUdKeEM7QUFISSxNQUlGLEtBQUtoSSxJQUpUO0FBS0EsTUFBSSxDQUFDdUMsSUFBRCxJQUFTLENBQUNpSSxjQUFkLEVBQStCO0FBQzdCO0FBQ0Q7QUFDRCxNQUFJLENBQUNqSSxLQUFLOUIsUUFBVixFQUFvQjtBQUNsQjtBQUNEO0FBQ0QsT0FBS2IsTUFBTCxDQUFZbUQsUUFBWixDQUFxQjZILE9BQXJCLENBQTZCLFVBQTdCLEVBQXlDO0FBQ3ZDckksUUFEdUM7QUFFdkNpSSxrQkFGdUM7QUFHdkN4QyxrQkFBYyxFQUFFLE9BQU9BLFlBQVQ7QUFIeUIsR0FBekM7QUFLRCxDQXRCRDs7QUF3QkE7QUFDQXJJLFVBQVVxQixTQUFWLENBQW9Ca0IsY0FBcEIsR0FBcUMsWUFBVztBQUM5QyxNQUFJLEtBQUs1QixPQUFMLElBQWdCLEtBQUtBLE9BQUwsQ0FBYSxlQUFiLENBQWhCLElBQWlELEtBQUtWLE1BQUwsQ0FBWWlMLDRCQUFqRSxFQUErRjtBQUM3RixRQUFJQyxlQUFlO0FBQ2pCdkksWUFBTTtBQUNKcUYsZ0JBQVEsU0FESjtBQUVKOUgsbUJBQVcsT0FGUDtBQUdKVyxrQkFBVSxLQUFLQSxRQUFMO0FBSE47QUFEVyxLQUFuQjtBQU9BLFdBQU8sS0FBS0gsT0FBTCxDQUFhLGVBQWIsQ0FBUDtBQUNBLFdBQU8sS0FBS1YsTUFBTCxDQUFZbUQsUUFBWixDQUFxQjZILE9BQXJCLENBQTZCLFVBQTdCLEVBQXlDRSxZQUF6QyxFQUNKMUosSUFESSxDQUNDLEtBQUtjLGNBQUwsQ0FBb0I2SSxJQUFwQixDQUF5QixJQUF6QixDQURELENBQVA7QUFFRDs7QUFFRCxNQUFJLEtBQUt6SyxPQUFMLElBQWdCLEtBQUtBLE9BQUwsQ0FBYSxvQkFBYixDQUFwQixFQUF3RDtBQUN0RCxXQUFPLEtBQUtBLE9BQUwsQ0FBYSxvQkFBYixDQUFQO0FBQ0EsV0FBTyxLQUFLaUssa0JBQUwsR0FDSm5KLElBREksQ0FDQyxLQUFLYyxjQUFMLENBQW9CNkksSUFBcEIsQ0FBeUIsSUFBekIsQ0FERCxDQUFQO0FBRUQ7O0FBRUQsTUFBSSxLQUFLekssT0FBTCxJQUFnQixLQUFLQSxPQUFMLENBQWEsdUJBQWIsQ0FBcEIsRUFBMkQ7QUFDekQsV0FBTyxLQUFLQSxPQUFMLENBQWEsdUJBQWIsQ0FBUDtBQUNBO0FBQ0EsU0FBS1YsTUFBTCxDQUFZc0osY0FBWixDQUEyQjhCLHFCQUEzQixDQUFpRCxLQUFLaEwsSUFBdEQ7QUFDQSxXQUFPLEtBQUtrQyxjQUFMLENBQW9CNkksSUFBcEIsQ0FBeUIsSUFBekIsQ0FBUDtBQUNEO0FBQ0YsQ0ExQkQ7O0FBNEJBO0FBQ0E7QUFDQXBMLFVBQVVxQixTQUFWLENBQW9CUSxhQUFwQixHQUFvQyxZQUFXO0FBQzdDLE1BQUksS0FBS2IsUUFBTCxJQUFpQixLQUFLYixTQUFMLEtBQW1CLFVBQXhDLEVBQW9EO0FBQ2xEO0FBQ0Q7O0FBRUQsTUFBSSxDQUFDLEtBQUtELElBQUwsQ0FBVTBDLElBQVgsSUFBbUIsQ0FBQyxLQUFLMUMsSUFBTCxDQUFVd0MsUUFBbEMsRUFBNEM7QUFDMUMsVUFBTSxJQUFJN0MsTUFBTVksS0FBVixDQUFnQlosTUFBTVksS0FBTixDQUFZNksscUJBQTVCLEVBQ0oseUJBREksQ0FBTjtBQUVEOztBQUVEO0FBQ0EsTUFBSSxLQUFLakwsSUFBTCxDQUFVMEcsR0FBZCxFQUFtQjtBQUNqQixVQUFNLElBQUlsSCxNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlNLGdCQUE1QixFQUE4QyxnQkFDOUIsbUJBRGhCLENBQU47QUFFRDs7QUFFRCxNQUFJLEtBQUtYLEtBQVQsRUFBZ0I7QUFDZCxRQUFJLEtBQUtDLElBQUwsQ0FBVXVDLElBQVYsSUFBa0IsQ0FBQyxLQUFLMUMsSUFBTCxDQUFVd0MsUUFBN0IsSUFBeUMsS0FBS3JDLElBQUwsQ0FBVXVDLElBQVYsQ0FBZTlCLFFBQWYsSUFBMkIsS0FBS1osSUFBTCxDQUFVMEMsSUFBVixDQUFlSSxFQUF2RixFQUEyRjtBQUN6RixZQUFNLElBQUluRCxNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlNLGdCQUE1QixDQUFOO0FBQ0QsS0FGRCxNQUVPLElBQUksS0FBS1YsSUFBTCxDQUFVd0ssY0FBZCxFQUE4QjtBQUNuQyxZQUFNLElBQUloTCxNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlNLGdCQUE1QixDQUFOO0FBQ0QsS0FGTSxNQUVBLElBQUksS0FBS1YsSUFBTCxDQUFVZ0ksWUFBZCxFQUE0QjtBQUNqQyxZQUFNLElBQUl4SSxNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlNLGdCQUE1QixDQUFOO0FBQ0Q7QUFDRjs7QUFFRCxNQUFJLENBQUMsS0FBS1gsS0FBTixJQUFlLENBQUMsS0FBS0YsSUFBTCxDQUFVd0MsUUFBOUIsRUFBd0M7QUFDdEMsVUFBTTZJLHdCQUF3QixFQUE5QjtBQUNBLFNBQUssSUFBSTlHLEdBQVQsSUFBZ0IsS0FBS3BFLElBQXJCLEVBQTJCO0FBQ3pCLFVBQUlvRSxRQUFRLFVBQVIsSUFBc0JBLFFBQVEsTUFBbEMsRUFBMEM7QUFDeEM7QUFDRDtBQUNEOEcsNEJBQXNCOUcsR0FBdEIsSUFBNkIsS0FBS3BFLElBQUwsQ0FBVW9FLEdBQVYsQ0FBN0I7QUFDRDs7QUFFRCxVQUFNLEVBQUVxRyxXQUFGLEVBQWVDLGFBQWYsS0FBaUNyTCxLQUFLcUwsYUFBTCxDQUFtQixLQUFLOUssTUFBeEIsRUFBZ0M7QUFDckV5SCxjQUFRLEtBQUt4SCxJQUFMLENBQVUwQyxJQUFWLENBQWVJLEVBRDhDO0FBRXJFZ0ksbUJBQWE7QUFDWFEsZ0JBQVE7QUFERyxPQUZ3RDtBQUtyRUQ7QUFMcUUsS0FBaEMsQ0FBdkM7O0FBUUEsV0FBT1IsZ0JBQWdCdEosSUFBaEIsQ0FBc0J1RixPQUFELElBQWE7QUFDdkMsVUFBSSxDQUFDQSxRQUFRaEcsUUFBYixFQUF1QjtBQUNyQixjQUFNLElBQUluQixNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlnTCxxQkFBNUIsRUFDSix5QkFESSxDQUFOO0FBRUQ7QUFDRFgsa0JBQVksVUFBWixJQUEwQjlELFFBQVFoRyxRQUFSLENBQWlCLFVBQWpCLENBQTFCO0FBQ0EsV0FBS0EsUUFBTCxHQUFnQjtBQUNkMEssZ0JBQVEsR0FETTtBQUVkL0Qsa0JBQVVYLFFBQVFXLFFBRko7QUFHZDNHLGtCQUFVOEo7QUFISSxPQUFoQjtBQUtELEtBWE0sQ0FBUDtBQVlEO0FBQ0YsQ0F4REQ7O0FBMERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTlLLFVBQVVxQixTQUFWLENBQW9CTyxrQkFBcEIsR0FBeUMsWUFBVztBQUNsRCxNQUFJLEtBQUtaLFFBQUwsSUFBaUIsS0FBS2IsU0FBTCxLQUFtQixlQUF4QyxFQUF5RDtBQUN2RDtBQUNEOztBQUVELE1BQUksQ0FBQyxLQUFLQyxLQUFOLElBQWUsQ0FBQyxLQUFLQyxJQUFMLENBQVVzTCxXQUExQixJQUF5QyxDQUFDLEtBQUt0TCxJQUFMLENBQVV3SyxjQUFwRCxJQUFzRSxDQUFDLEtBQUszSyxJQUFMLENBQVUySyxjQUFyRixFQUFxRztBQUNuRyxVQUFNLElBQUloTCxNQUFNWSxLQUFWLENBQWdCLEdBQWhCLEVBQ0oseURBQ29CLHFDQUZoQixDQUFOO0FBR0Q7O0FBRUQ7QUFDQTtBQUNBLE1BQUksS0FBS0osSUFBTCxDQUFVc0wsV0FBVixJQUF5QixLQUFLdEwsSUFBTCxDQUFVc0wsV0FBVixDQUFzQnBHLE1BQXRCLElBQWdDLEVBQTdELEVBQWlFO0FBQy9ELFNBQUtsRixJQUFMLENBQVVzTCxXQUFWLEdBQXdCLEtBQUt0TCxJQUFMLENBQVVzTCxXQUFWLENBQXNCQyxXQUF0QixFQUF4QjtBQUNEOztBQUVEO0FBQ0EsTUFBSSxLQUFLdkwsSUFBTCxDQUFVd0ssY0FBZCxFQUE4QjtBQUM1QixTQUFLeEssSUFBTCxDQUFVd0ssY0FBVixHQUEyQixLQUFLeEssSUFBTCxDQUFVd0ssY0FBVixDQUF5QmUsV0FBekIsRUFBM0I7QUFDRDs7QUFFRCxNQUFJZixpQkFBaUIsS0FBS3hLLElBQUwsQ0FBVXdLLGNBQS9COztBQUVBO0FBQ0EsTUFBSSxDQUFDQSxjQUFELElBQW1CLENBQUMsS0FBSzNLLElBQUwsQ0FBVXdDLFFBQWxDLEVBQTRDO0FBQzFDbUkscUJBQWlCLEtBQUszSyxJQUFMLENBQVUySyxjQUEzQjtBQUNEOztBQUVELE1BQUlBLGNBQUosRUFBb0I7QUFDbEJBLHFCQUFpQkEsZUFBZWUsV0FBZixFQUFqQjtBQUNEOztBQUVEO0FBQ0EsTUFBSSxLQUFLeEwsS0FBTCxJQUFjLENBQUMsS0FBS0MsSUFBTCxDQUFVc0wsV0FBekIsSUFDZSxDQUFDZCxjQURoQixJQUNrQyxDQUFDLEtBQUt4SyxJQUFMLENBQVV3TCxVQURqRCxFQUM2RDtBQUMzRDtBQUNEOztBQUVELE1BQUloRSxVQUFVdEcsUUFBUUMsT0FBUixFQUFkOztBQUVBLE1BQUlzSyxPQUFKLENBekNrRCxDQXlDckM7QUFDYixNQUFJQyxhQUFKO0FBQ0EsTUFBSUMsbUJBQUo7QUFDQSxNQUFJQyxxQkFBcUIsRUFBekI7O0FBRUE7QUFDQSxRQUFNQyxZQUFZLEVBQWxCO0FBQ0EsTUFBSSxLQUFLOUwsS0FBTCxJQUFjLEtBQUtBLEtBQUwsQ0FBV1UsUUFBN0IsRUFBdUM7QUFDckNvTCxjQUFVdkgsSUFBVixDQUFlO0FBQ2I3RCxnQkFBVSxLQUFLVixLQUFMLENBQVdVO0FBRFIsS0FBZjtBQUdEO0FBQ0QsTUFBSStKLGNBQUosRUFBb0I7QUFDbEJxQixjQUFVdkgsSUFBVixDQUFlO0FBQ2Isd0JBQWtCa0c7QUFETCxLQUFmO0FBR0Q7QUFDRCxNQUFJLEtBQUt4SyxJQUFMLENBQVVzTCxXQUFkLEVBQTJCO0FBQ3pCTyxjQUFVdkgsSUFBVixDQUFlLEVBQUMsZUFBZSxLQUFLdEUsSUFBTCxDQUFVc0wsV0FBMUIsRUFBZjtBQUNEOztBQUVELE1BQUlPLFVBQVUzRyxNQUFWLElBQW9CLENBQXhCLEVBQTJCO0FBQ3pCO0FBQ0Q7O0FBRURzQyxZQUFVQSxRQUFRcEcsSUFBUixDQUFhLE1BQU07QUFDM0IsV0FBTyxLQUFLeEIsTUFBTCxDQUFZbUQsUUFBWixDQUFxQndELElBQXJCLENBQTBCLGVBQTFCLEVBQTJDO0FBQ2hELGFBQU9zRjtBQUR5QyxLQUEzQyxFQUVKLEVBRkksQ0FBUDtBQUdELEdBSlMsRUFJUHpLLElBSk8sQ0FJRHVGLE9BQUQsSUFBYTtBQUNuQkEsWUFBUU0sT0FBUixDQUFpQi9DLE1BQUQsSUFBWTtBQUMxQixVQUFJLEtBQUtuRSxLQUFMLElBQWMsS0FBS0EsS0FBTCxDQUFXVSxRQUF6QixJQUFxQ3lELE9BQU96RCxRQUFQLElBQW1CLEtBQUtWLEtBQUwsQ0FBV1UsUUFBdkUsRUFBaUY7QUFDL0VpTCx3QkFBZ0J4SCxNQUFoQjtBQUNEO0FBQ0QsVUFBSUEsT0FBT3NHLGNBQVAsSUFBeUJBLGNBQTdCLEVBQTZDO0FBQzNDbUIsOEJBQXNCekgsTUFBdEI7QUFDRDtBQUNELFVBQUlBLE9BQU9vSCxXQUFQLElBQXNCLEtBQUt0TCxJQUFMLENBQVVzTCxXQUFwQyxFQUFpRDtBQUMvQ00sMkJBQW1CdEgsSUFBbkIsQ0FBd0JKLE1BQXhCO0FBQ0Q7QUFDRixLQVZEOztBQVlBO0FBQ0EsUUFBSSxLQUFLbkUsS0FBTCxJQUFjLEtBQUtBLEtBQUwsQ0FBV1UsUUFBN0IsRUFBdUM7QUFDckMsVUFBSSxDQUFDaUwsYUFBTCxFQUFvQjtBQUNsQixjQUFNLElBQUlsTSxNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVkwTCxnQkFBNUIsRUFDSiw4QkFESSxDQUFOO0FBRUQ7QUFDRCxVQUFJLEtBQUs5TCxJQUFMLENBQVV3SyxjQUFWLElBQTRCa0IsY0FBY2xCLGNBQTFDLElBQ0EsS0FBS3hLLElBQUwsQ0FBVXdLLGNBQVYsS0FBNkJrQixjQUFjbEIsY0FEL0MsRUFDK0Q7QUFDN0QsY0FBTSxJQUFJaEwsTUFBTVksS0FBVixDQUFnQixHQUFoQixFQUNKLCtDQUNzQixXQUZsQixDQUFOO0FBR0Q7QUFDRCxVQUFJLEtBQUtKLElBQUwsQ0FBVXNMLFdBQVYsSUFBeUJJLGNBQWNKLFdBQXZDLElBQ0EsS0FBS3RMLElBQUwsQ0FBVXNMLFdBQVYsS0FBMEJJLGNBQWNKLFdBRHhDLElBRUEsQ0FBQyxLQUFLdEwsSUFBTCxDQUFVd0ssY0FGWCxJQUU2QixDQUFDa0IsY0FBY2xCLGNBRmhELEVBRWdFO0FBQzlELGNBQU0sSUFBSWhMLE1BQU1ZLEtBQVYsQ0FBZ0IsR0FBaEIsRUFDSiw0Q0FDc0IsV0FGbEIsQ0FBTjtBQUdEO0FBQ0QsVUFBSSxLQUFLSixJQUFMLENBQVV3TCxVQUFWLElBQXdCLEtBQUt4TCxJQUFMLENBQVV3TCxVQUFsQyxJQUNBLEtBQUt4TCxJQUFMLENBQVV3TCxVQUFWLEtBQXlCRSxjQUFjRixVQUQzQyxFQUN1RDtBQUNyRCxjQUFNLElBQUloTSxNQUFNWSxLQUFWLENBQWdCLEdBQWhCLEVBQ0osMkNBQ3NCLFdBRmxCLENBQU47QUFHRDtBQUNGOztBQUVELFFBQUksS0FBS0wsS0FBTCxJQUFjLEtBQUtBLEtBQUwsQ0FBV1UsUUFBekIsSUFBcUNpTCxhQUF6QyxFQUF3RDtBQUN0REQsZ0JBQVVDLGFBQVY7QUFDRDs7QUFFRCxRQUFJbEIsa0JBQWtCbUIsbUJBQXRCLEVBQTJDO0FBQ3pDRixnQkFBVUUsbUJBQVY7QUFDRDtBQUNEO0FBQ0EsUUFBSSxDQUFDLEtBQUs1TCxLQUFOLElBQWUsQ0FBQyxLQUFLQyxJQUFMLENBQVV3TCxVQUExQixJQUF3QyxDQUFDQyxPQUE3QyxFQUFzRDtBQUNwRCxZQUFNLElBQUlqTSxNQUFNWSxLQUFWLENBQWdCLEdBQWhCLEVBQ0osZ0RBREksQ0FBTjtBQUVEO0FBRUYsR0F6RFMsRUF5RFBnQixJQXpETyxDQXlERixNQUFNO0FBQ1osUUFBSSxDQUFDcUssT0FBTCxFQUFjO0FBQ1osVUFBSSxDQUFDRyxtQkFBbUIxRyxNQUF4QixFQUFnQztBQUM5QjtBQUNELE9BRkQsTUFFTyxJQUFJMEcsbUJBQW1CMUcsTUFBbkIsSUFBNkIsQ0FBN0IsS0FDUixDQUFDMEcsbUJBQW1CLENBQW5CLEVBQXNCLGdCQUF0QixDQUFELElBQTRDLENBQUNwQixjQURyQyxDQUFKLEVBRUw7QUFDQTtBQUNBO0FBQ0E7QUFDQSxlQUFPb0IsbUJBQW1CLENBQW5CLEVBQXNCLFVBQXRCLENBQVA7QUFDRCxPQVBNLE1BT0EsSUFBSSxDQUFDLEtBQUs1TCxJQUFMLENBQVV3SyxjQUFmLEVBQStCO0FBQ3BDLGNBQU0sSUFBSWhMLE1BQU1ZLEtBQVYsQ0FBZ0IsR0FBaEIsRUFDSixrREFDb0IsdUNBRmhCLENBQU47QUFHRCxPQUpNLE1BSUE7QUFDTDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsWUFBSTJMLFdBQVc7QUFDYix5QkFBZSxLQUFLL0wsSUFBTCxDQUFVc0wsV0FEWjtBQUViLDRCQUFrQjtBQUNoQixtQkFBT2Q7QUFEUztBQUZMLFNBQWY7QUFNQSxZQUFJLEtBQUt4SyxJQUFMLENBQVVnTSxhQUFkLEVBQTZCO0FBQzNCRCxtQkFBUyxlQUFULElBQTRCLEtBQUsvTCxJQUFMLENBQVVnTSxhQUF0QztBQUNEO0FBQ0QsYUFBS3BNLE1BQUwsQ0FBWW1ELFFBQVosQ0FBcUI2SCxPQUFyQixDQUE2QixlQUE3QixFQUE4Q21CLFFBQTlDLEVBQ0c1QixLQURILENBQ1NDLE9BQU87QUFDWixjQUFJQSxJQUFJNkIsSUFBSixJQUFZek0sTUFBTVksS0FBTixDQUFZMEwsZ0JBQTVCLEVBQThDO0FBQzVDO0FBQ0E7QUFDRDtBQUNEO0FBQ0EsZ0JBQU0xQixHQUFOO0FBQ0QsU0FSSDtBQVNBO0FBQ0Q7QUFDRixLQXhDRCxNQXdDTztBQUNMLFVBQUl3QixtQkFBbUIxRyxNQUFuQixJQUE2QixDQUE3QixJQUNGLENBQUMwRyxtQkFBbUIsQ0FBbkIsRUFBc0IsZ0JBQXRCLENBREgsRUFDNEM7QUFDMUM7QUFDQTtBQUNBO0FBQ0EsY0FBTUcsV0FBVyxFQUFDdEwsVUFBVWdMLFFBQVFoTCxRQUFuQixFQUFqQjtBQUNBLGVBQU8sS0FBS2IsTUFBTCxDQUFZbUQsUUFBWixDQUFxQjZILE9BQXJCLENBQTZCLGVBQTdCLEVBQThDbUIsUUFBOUMsRUFDSjNLLElBREksQ0FDQyxNQUFNO0FBQ1YsaUJBQU93SyxtQkFBbUIsQ0FBbkIsRUFBc0IsVUFBdEIsQ0FBUDtBQUNELFNBSEksRUFJSnpCLEtBSkksQ0FJRUMsT0FBTztBQUNaLGNBQUlBLElBQUk2QixJQUFKLElBQVl6TSxNQUFNWSxLQUFOLENBQVkwTCxnQkFBNUIsRUFBOEM7QUFDNUM7QUFDQTtBQUNEO0FBQ0Q7QUFDQSxnQkFBTTFCLEdBQU47QUFDRCxTQVhJLENBQVA7QUFZRCxPQWxCRCxNQWtCTztBQUNMLFlBQUksS0FBS3BLLElBQUwsQ0FBVXNMLFdBQVYsSUFDRkcsUUFBUUgsV0FBUixJQUF1QixLQUFLdEwsSUFBTCxDQUFVc0wsV0FEbkMsRUFDZ0Q7QUFDOUM7QUFDQTtBQUNBO0FBQ0EsZ0JBQU1TLFdBQVc7QUFDZiwyQkFBZSxLQUFLL0wsSUFBTCxDQUFVc0w7QUFEVixXQUFqQjtBQUdBO0FBQ0E7QUFDQSxjQUFJLEtBQUt0TCxJQUFMLENBQVV3SyxjQUFkLEVBQThCO0FBQzVCdUIscUJBQVMsZ0JBQVQsSUFBNkI7QUFDM0IscUJBQU8sS0FBSy9MLElBQUwsQ0FBVXdLO0FBRFUsYUFBN0I7QUFHRCxXQUpELE1BSU8sSUFBSWlCLFFBQVFoTCxRQUFSLElBQW9CLEtBQUtULElBQUwsQ0FBVVMsUUFBOUIsSUFDRWdMLFFBQVFoTCxRQUFSLElBQW9CLEtBQUtULElBQUwsQ0FBVVMsUUFEcEMsRUFDOEM7QUFDbkQ7QUFDQXNMLHFCQUFTLFVBQVQsSUFBdUI7QUFDckIscUJBQU9OLFFBQVFoTDtBQURNLGFBQXZCO0FBR0QsV0FOTSxNQU1BO0FBQ0w7QUFDQSxtQkFBT2dMLFFBQVFoTCxRQUFmO0FBQ0Q7QUFDRCxjQUFJLEtBQUtULElBQUwsQ0FBVWdNLGFBQWQsRUFBNkI7QUFDM0JELHFCQUFTLGVBQVQsSUFBNEIsS0FBSy9MLElBQUwsQ0FBVWdNLGFBQXRDO0FBQ0Q7QUFDRCxlQUFLcE0sTUFBTCxDQUFZbUQsUUFBWixDQUFxQjZILE9BQXJCLENBQTZCLGVBQTdCLEVBQThDbUIsUUFBOUMsRUFDRzVCLEtBREgsQ0FDU0MsT0FBTztBQUNaLGdCQUFJQSxJQUFJNkIsSUFBSixJQUFZek0sTUFBTVksS0FBTixDQUFZMEwsZ0JBQTVCLEVBQThDO0FBQzVDO0FBQ0E7QUFDRDtBQUNEO0FBQ0Esa0JBQU0xQixHQUFOO0FBQ0QsV0FSSDtBQVNEO0FBQ0Q7QUFDQSxlQUFPcUIsUUFBUWhMLFFBQWY7QUFDRDtBQUNGO0FBQ0YsR0EvSlMsRUErSlBXLElBL0pPLENBK0pEOEssS0FBRCxJQUFXO0FBQ2pCLFFBQUlBLEtBQUosRUFBVztBQUNULFdBQUtuTSxLQUFMLEdBQWEsRUFBQ1UsVUFBVXlMLEtBQVgsRUFBYjtBQUNBLGFBQU8sS0FBS2xNLElBQUwsQ0FBVVMsUUFBakI7QUFDQSxhQUFPLEtBQUtULElBQUwsQ0FBVXVFLFNBQWpCO0FBQ0Q7QUFDRDtBQUNELEdBdEtTLENBQVY7QUF1S0EsU0FBT2lELE9BQVA7QUFDRCxDQTFPRDs7QUE0T0E7QUFDQTtBQUNBO0FBQ0E3SCxVQUFVcUIsU0FBVixDQUFvQmMsNkJBQXBCLEdBQW9ELFlBQVc7QUFDN0Q7QUFDQSxNQUFJLEtBQUtuQixRQUFMLElBQWlCLEtBQUtBLFFBQUwsQ0FBY0EsUUFBbkMsRUFBNkM7QUFDM0MsU0FBS2YsTUFBTCxDQUFZdU0sZUFBWixDQUE0QkMsbUJBQTVCLENBQWdELEtBQUt4TSxNQUFyRCxFQUE2RCxLQUFLZSxRQUFMLENBQWNBLFFBQTNFO0FBQ0Q7QUFDRixDQUxEOztBQU9BaEIsVUFBVXFCLFNBQVYsQ0FBb0JnQixvQkFBcEIsR0FBMkMsWUFBVztBQUNwRCxNQUFJLEtBQUtyQixRQUFULEVBQW1CO0FBQ2pCO0FBQ0Q7O0FBRUQsTUFBSSxLQUFLYixTQUFMLEtBQW1CLE9BQXZCLEVBQWdDO0FBQzlCLFNBQUtGLE1BQUwsQ0FBWWtJLGVBQVosQ0FBNEJ1RSxJQUE1QixDQUFpQ0MsS0FBakM7QUFDRDs7QUFFRCxNQUFJLEtBQUt4TSxTQUFMLEtBQW1CLE9BQW5CLElBQ0EsS0FBS0MsS0FETCxJQUVBLEtBQUtGLElBQUwsQ0FBVTBNLGlCQUFWLEVBRkosRUFFbUM7QUFDakMsVUFBTSxJQUFJL00sTUFBTVksS0FBVixDQUFnQlosTUFBTVksS0FBTixDQUFZb00sZUFBNUIsRUFBOEMsc0JBQXFCLEtBQUt6TSxLQUFMLENBQVdVLFFBQVMsR0FBdkYsQ0FBTjtBQUNEOztBQUVELE1BQUksS0FBS1gsU0FBTCxLQUFtQixVQUFuQixJQUFpQyxLQUFLRSxJQUFMLENBQVV5TSxRQUEvQyxFQUF5RDtBQUN2RCxTQUFLek0sSUFBTCxDQUFVME0sWUFBVixHQUF5QixLQUFLMU0sSUFBTCxDQUFVeU0sUUFBVixDQUFtQkUsSUFBNUM7QUFDRDs7QUFFRDtBQUNBO0FBQ0EsTUFBSSxLQUFLM00sSUFBTCxDQUFVMEcsR0FBVixJQUFpQixLQUFLMUcsSUFBTCxDQUFVMEcsR0FBVixDQUFjLGFBQWQsQ0FBckIsRUFBbUQ7QUFDakQsVUFBTSxJQUFJbEgsTUFBTVksS0FBVixDQUFnQlosTUFBTVksS0FBTixDQUFZd00sV0FBNUIsRUFBeUMsY0FBekMsQ0FBTjtBQUNEOztBQUVELE1BQUksS0FBSzdNLEtBQVQsRUFBZ0I7QUFDZDtBQUNBO0FBQ0EsUUFBSSxLQUFLRCxTQUFMLEtBQW1CLE9BQW5CLElBQThCLEtBQUtFLElBQUwsQ0FBVTBHLEdBQXhDLElBQStDLEtBQUs3RyxJQUFMLENBQVV3QyxRQUFWLEtBQXVCLElBQTFFLEVBQWdGO0FBQzlFLFdBQUtyQyxJQUFMLENBQVUwRyxHQUFWLENBQWMsS0FBSzNHLEtBQUwsQ0FBV1UsUUFBekIsSUFBcUMsRUFBRW9NLE1BQU0sSUFBUixFQUFjQyxPQUFPLElBQXJCLEVBQXJDO0FBQ0Q7QUFDRDtBQUNBLFFBQUksS0FBS2hOLFNBQUwsS0FBbUIsT0FBbkIsSUFBOEIsS0FBS0UsSUFBTCxDQUFVcUksZ0JBQXhDLElBQTRELEtBQUt6SSxNQUFMLENBQVl3SixjQUF4RSxJQUEwRixLQUFLeEosTUFBTCxDQUFZd0osY0FBWixDQUEyQjJELGNBQXpILEVBQXlJO0FBQ3ZJLFdBQUsvTSxJQUFMLENBQVVnTixvQkFBVixHQUFpQ3hOLE1BQU1xQixPQUFOLENBQWMsSUFBSUMsSUFBSixFQUFkLENBQWpDO0FBQ0Q7QUFDRDtBQUNBLFdBQU8sS0FBS2QsSUFBTCxDQUFVdUUsU0FBakI7O0FBRUEsUUFBSTBJLFFBQVEvTCxRQUFRQyxPQUFSLEVBQVo7QUFDQTtBQUNBLFFBQUksS0FBS3JCLFNBQUwsS0FBbUIsT0FBbkIsSUFBOEIsS0FBS0UsSUFBTCxDQUFVcUksZ0JBQXhDLElBQTRELEtBQUt6SSxNQUFMLENBQVl3SixjQUF4RSxJQUEwRixLQUFLeEosTUFBTCxDQUFZd0osY0FBWixDQUEyQlEsa0JBQXpILEVBQTZJO0FBQzNJcUQsY0FBUSxLQUFLck4sTUFBTCxDQUFZbUQsUUFBWixDQUFxQndELElBQXJCLENBQTBCLE9BQTFCLEVBQW1DLEVBQUM5RixVQUFVLEtBQUtBLFFBQUwsRUFBWCxFQUFuQyxFQUFnRSxFQUFDd0UsTUFBTSxDQUFDLG1CQUFELEVBQXNCLGtCQUF0QixDQUFQLEVBQWhFLEVBQW1IN0QsSUFBbkgsQ0FBd0h1RixXQUFXO0FBQ3pJLFlBQUlBLFFBQVF6QixNQUFSLElBQWtCLENBQXRCLEVBQXlCO0FBQ3ZCLGdCQUFNK0MsU0FBTjtBQUNEO0FBQ0QsY0FBTTFGLE9BQU9vRSxRQUFRLENBQVIsQ0FBYjtBQUNBLFlBQUlrRCxlQUFlLEVBQW5CO0FBQ0EsWUFBSXRILEtBQUt1SCxpQkFBVCxFQUE0QjtBQUMxQkQseUJBQWU3RixpQkFBRStGLElBQUYsQ0FBT3hILEtBQUt1SCxpQkFBWixFQUErQixLQUFLbEssTUFBTCxDQUFZd0osY0FBWixDQUEyQlEsa0JBQTFELENBQWY7QUFDRDtBQUNEO0FBQ0EsZUFBT0MsYUFBYTNFLE1BQWIsR0FBc0IsS0FBS3RGLE1BQUwsQ0FBWXdKLGNBQVosQ0FBMkJRLGtCQUEzQixHQUFnRCxDQUE3RSxFQUFnRjtBQUM5RUMsdUJBQWFxRCxLQUFiO0FBQ0Q7QUFDRHJELHFCQUFhdkYsSUFBYixDQUFrQi9CLEtBQUt1QyxRQUF2QjtBQUNBLGFBQUs5RSxJQUFMLENBQVU4SixpQkFBVixHQUE4QkQsWUFBOUI7QUFDRCxPQWZPLENBQVI7QUFnQkQ7O0FBRUQsV0FBT29ELE1BQU03TCxJQUFOLENBQVcsTUFBTTtBQUN0QjtBQUNBLGFBQU8sS0FBS3hCLE1BQUwsQ0FBWW1ELFFBQVosQ0FBcUJ3RSxNQUFyQixDQUE0QixLQUFLekgsU0FBakMsRUFBNEMsS0FBS0MsS0FBakQsRUFBd0QsS0FBS0MsSUFBN0QsRUFBbUUsS0FBS08sVUFBeEUsRUFDSmEsSUFESSxDQUNDVCxZQUFZO0FBQ2hCQSxpQkFBU0MsU0FBVCxHQUFxQixLQUFLQSxTQUExQjtBQUNBLGFBQUt1TSx1QkFBTCxDQUE2QnhNLFFBQTdCLEVBQXVDLEtBQUtYLElBQTVDO0FBQ0EsYUFBS1csUUFBTCxHQUFnQixFQUFFQSxRQUFGLEVBQWhCO0FBQ0QsT0FMSSxDQUFQO0FBTUQsS0FSTSxDQUFQO0FBU0QsR0EzQ0QsTUEyQ087QUFDTDtBQUNBLFFBQUksS0FBS2IsU0FBTCxLQUFtQixPQUF2QixFQUFnQztBQUM5QixVQUFJNEcsTUFBTSxLQUFLMUcsSUFBTCxDQUFVMEcsR0FBcEI7QUFDQTtBQUNBLFVBQUksQ0FBQ0EsR0FBTCxFQUFVO0FBQ1JBLGNBQU0sRUFBTjtBQUNBQSxZQUFJLEdBQUosSUFBVyxFQUFFbUcsTUFBTSxJQUFSLEVBQWNDLE9BQU8sS0FBckIsRUFBWDtBQUNEO0FBQ0Q7QUFDQXBHLFVBQUksS0FBSzFHLElBQUwsQ0FBVVMsUUFBZCxJQUEwQixFQUFFb00sTUFBTSxJQUFSLEVBQWNDLE9BQU8sSUFBckIsRUFBMUI7QUFDQSxXQUFLOU0sSUFBTCxDQUFVMEcsR0FBVixHQUFnQkEsR0FBaEI7QUFDQTtBQUNBLFVBQUksS0FBSzlHLE1BQUwsQ0FBWXdKLGNBQVosSUFBOEIsS0FBS3hKLE1BQUwsQ0FBWXdKLGNBQVosQ0FBMkIyRCxjQUE3RCxFQUE2RTtBQUMzRSxhQUFLL00sSUFBTCxDQUFVZ04sb0JBQVYsR0FBaUN4TixNQUFNcUIsT0FBTixDQUFjLElBQUlDLElBQUosRUFBZCxDQUFqQztBQUNEO0FBQ0Y7O0FBRUQ7QUFDQSxXQUFPLEtBQUtsQixNQUFMLENBQVltRCxRQUFaLENBQXFCcUssTUFBckIsQ0FBNEIsS0FBS3ROLFNBQWpDLEVBQTRDLEtBQUtFLElBQWpELEVBQXVELEtBQUtPLFVBQTVELEVBQ0o0SixLQURJLENBQ0UxQyxTQUFTO0FBQ2QsVUFBSSxLQUFLM0gsU0FBTCxLQUFtQixPQUFuQixJQUE4QjJILE1BQU13RSxJQUFOLEtBQWV6TSxNQUFNWSxLQUFOLENBQVlpTixlQUE3RCxFQUE4RTtBQUM1RSxjQUFNNUYsS0FBTjtBQUNEOztBQUVEO0FBQ0EsVUFBSUEsU0FBU0EsTUFBTTZGLFFBQWYsSUFBMkI3RixNQUFNNkYsUUFBTixDQUFlQyxnQkFBZixLQUFvQyxVQUFuRSxFQUErRTtBQUM3RSxjQUFNLElBQUkvTixNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVl1SSxjQUE1QixFQUE0QywyQ0FBNUMsQ0FBTjtBQUNEOztBQUVELFVBQUlsQixTQUFTQSxNQUFNNkYsUUFBZixJQUEyQjdGLE1BQU02RixRQUFOLENBQWVDLGdCQUFmLEtBQW9DLE9BQW5FLEVBQTRFO0FBQzFFLGNBQU0sSUFBSS9OLE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWTZJLFdBQTVCLEVBQXlDLGdEQUF6QyxDQUFOO0FBQ0Q7O0FBRUQ7QUFDQTtBQUNBO0FBQ0E7QUFDQSxhQUFPLEtBQUtySixNQUFMLENBQVltRCxRQUFaLENBQXFCd0QsSUFBckIsQ0FDTCxLQUFLekcsU0FEQSxFQUVMLEVBQUU2RSxVQUFVLEtBQUszRSxJQUFMLENBQVUyRSxRQUF0QixFQUFnQ2xFLFVBQVUsRUFBQyxPQUFPLEtBQUtBLFFBQUwsRUFBUixFQUExQyxFQUZLLEVBR0wsRUFBRWlJLE9BQU8sQ0FBVCxFQUhLLEVBS0p0SCxJQUxJLENBS0N1RixXQUFXO0FBQ2YsWUFBSUEsUUFBUXpCLE1BQVIsR0FBaUIsQ0FBckIsRUFBd0I7QUFDdEIsZ0JBQU0sSUFBSTFGLE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWXVJLGNBQTVCLEVBQTRDLDJDQUE1QyxDQUFOO0FBQ0Q7QUFDRCxlQUFPLEtBQUsvSSxNQUFMLENBQVltRCxRQUFaLENBQXFCd0QsSUFBckIsQ0FDTCxLQUFLekcsU0FEQSxFQUVMLEVBQUU4SSxPQUFPLEtBQUs1SSxJQUFMLENBQVU0SSxLQUFuQixFQUEwQm5JLFVBQVUsRUFBQyxPQUFPLEtBQUtBLFFBQUwsRUFBUixFQUFwQyxFQUZLLEVBR0wsRUFBRWlJLE9BQU8sQ0FBVCxFQUhLLENBQVA7QUFLRCxPQWRJLEVBZUp0SCxJQWZJLENBZUN1RixXQUFXO0FBQ2YsWUFBSUEsUUFBUXpCLE1BQVIsR0FBaUIsQ0FBckIsRUFBd0I7QUFDdEIsZ0JBQU0sSUFBSTFGLE1BQU1ZLEtBQVYsQ0FBZ0JaLE1BQU1ZLEtBQU4sQ0FBWTZJLFdBQTVCLEVBQXlDLGdEQUF6QyxDQUFOO0FBQ0Q7QUFDRCxjQUFNLElBQUl6SixNQUFNWSxLQUFWLENBQWdCWixNQUFNWSxLQUFOLENBQVlpTixlQUE1QixFQUE2QywrREFBN0MsQ0FBTjtBQUNELE9BcEJJLENBQVA7QUFxQkQsS0F4Q0ksRUF5Q0pqTSxJQXpDSSxDQXlDQ1QsWUFBWTtBQUNoQkEsZUFBU0YsUUFBVCxHQUFvQixLQUFLVCxJQUFMLENBQVVTLFFBQTlCO0FBQ0FFLGVBQVM0RCxTQUFULEdBQXFCLEtBQUt2RSxJQUFMLENBQVV1RSxTQUEvQjs7QUFFQSxVQUFJLEtBQUtrRSwwQkFBVCxFQUFxQztBQUNuQzlILGlCQUFTZ0UsUUFBVCxHQUFvQixLQUFLM0UsSUFBTCxDQUFVMkUsUUFBOUI7QUFDRDtBQUNELFdBQUt3SSx1QkFBTCxDQUE2QnhNLFFBQTdCLEVBQXVDLEtBQUtYLElBQTVDO0FBQ0EsV0FBS1csUUFBTCxHQUFnQjtBQUNkMEssZ0JBQVEsR0FETTtBQUVkMUssZ0JBRmM7QUFHZDJHLGtCQUFVLEtBQUtBLFFBQUw7QUFISSxPQUFoQjtBQUtELEtBdERJLENBQVA7QUF1REQ7QUFDRixDQS9JRDs7QUFpSkE7QUFDQTNILFVBQVVxQixTQUFWLENBQW9CbUIsZUFBcEIsR0FBc0MsWUFBVztBQUMvQyxNQUFJLENBQUMsS0FBS3hCLFFBQU4sSUFBa0IsQ0FBQyxLQUFLQSxRQUFMLENBQWNBLFFBQXJDLEVBQStDO0FBQzdDO0FBQ0Q7O0FBRUQ7QUFDQSxRQUFNNk0sbUJBQW1CL04sU0FBUzJELGFBQVQsQ0FBdUIsS0FBS3RELFNBQTVCLEVBQXVDTCxTQUFTNEQsS0FBVCxDQUFlb0ssU0FBdEQsRUFBaUUsS0FBSzdOLE1BQUwsQ0FBWTJELGFBQTdFLENBQXpCO0FBQ0EsUUFBTW1LLGVBQWUsS0FBSzlOLE1BQUwsQ0FBWStOLG1CQUFaLENBQWdDRCxZQUFoQyxDQUE2QyxLQUFLNU4sU0FBbEQsQ0FBckI7QUFDQSxNQUFJLENBQUMwTixnQkFBRCxJQUFxQixDQUFDRSxZQUExQixFQUF3QztBQUN0QyxXQUFPeE0sUUFBUUMsT0FBUixFQUFQO0FBQ0Q7O0FBRUQsTUFBSXFDLFlBQVksRUFBQzFELFdBQVcsS0FBS0EsU0FBakIsRUFBaEI7QUFDQSxNQUFJLEtBQUtDLEtBQUwsSUFBYyxLQUFLQSxLQUFMLENBQVdVLFFBQTdCLEVBQXVDO0FBQ3JDK0MsY0FBVS9DLFFBQVYsR0FBcUIsS0FBS1YsS0FBTCxDQUFXVSxRQUFoQztBQUNEOztBQUVEO0FBQ0EsTUFBSWdELGNBQUo7QUFDQSxNQUFJLEtBQUsxRCxLQUFMLElBQWMsS0FBS0EsS0FBTCxDQUFXVSxRQUE3QixFQUF1QztBQUNyQ2dELHFCQUFpQmhFLFNBQVNtRSxPQUFULENBQWlCSixTQUFqQixFQUE0QixLQUFLdkQsWUFBakMsQ0FBakI7QUFDRDs7QUFFRDtBQUNBO0FBQ0EsUUFBTXlELGdCQUFnQixLQUFLQyxrQkFBTCxDQUF3QkgsU0FBeEIsQ0FBdEI7QUFDQUUsZ0JBQWNrSyxtQkFBZCxDQUFrQyxLQUFLak4sUUFBTCxDQUFjQSxRQUFoRCxFQUEwRCxLQUFLQSxRQUFMLENBQWMwSyxNQUFkLElBQXdCLEdBQWxGOztBQUVBO0FBQ0EsT0FBS3pMLE1BQUwsQ0FBWStOLG1CQUFaLENBQWdDRSxXQUFoQyxDQUE0Q25LLGNBQWM1RCxTQUExRCxFQUFxRTRELGFBQXJFLEVBQW9GRCxjQUFwRjs7QUFFQTtBQUNBLFNBQU9oRSxTQUFTb0UsZUFBVCxDQUF5QnBFLFNBQVM0RCxLQUFULENBQWVvSyxTQUF4QyxFQUFtRCxLQUFLNU4sSUFBeEQsRUFBOEQ2RCxhQUE5RCxFQUE2RUQsY0FBN0UsRUFBNkYsS0FBSzdELE1BQWxHLEVBQTBHLEtBQUtZLE9BQS9HLEVBQ0oySixLQURJLENBQ0UsVUFBU0MsR0FBVCxFQUFjO0FBQ25CMEQscUJBQU9DLElBQVAsQ0FBWSwyQkFBWixFQUF5QzNELEdBQXpDO0FBQ0QsR0FISSxDQUFQO0FBSUQsQ0FwQ0Q7O0FBc0NBO0FBQ0F6SyxVQUFVcUIsU0FBVixDQUFvQnNHLFFBQXBCLEdBQStCLFlBQVc7QUFDeEMsTUFBSTBHLFNBQVUsS0FBS2xPLFNBQUwsS0FBbUIsT0FBbkIsR0FBNkIsU0FBN0IsR0FDWixjQUFjLEtBQUtBLFNBQW5CLEdBQStCLEdBRGpDO0FBRUEsU0FBTyxLQUFLRixNQUFMLENBQVlxTyxLQUFaLEdBQW9CRCxNQUFwQixHQUE2QixLQUFLaE8sSUFBTCxDQUFVUyxRQUE5QztBQUNELENBSkQ7O0FBTUE7QUFDQTtBQUNBZCxVQUFVcUIsU0FBVixDQUFvQlAsUUFBcEIsR0FBK0IsWUFBVztBQUN4QyxTQUFPLEtBQUtULElBQUwsQ0FBVVMsUUFBVixJQUFzQixLQUFLVixLQUFMLENBQVdVLFFBQXhDO0FBQ0QsQ0FGRDs7QUFJQTtBQUNBZCxVQUFVcUIsU0FBVixDQUFvQmtOLGFBQXBCLEdBQW9DLFlBQVc7QUFDN0MsUUFBTWxPLE9BQU9nRixPQUFPQyxJQUFQLENBQVksS0FBS2pGLElBQWpCLEVBQXVCaUUsTUFBdkIsQ0FBOEIsQ0FBQ2pFLElBQUQsRUFBT29FLEdBQVAsS0FBZTtBQUN4RDtBQUNBLFFBQUksQ0FBRSx5QkFBRCxDQUE0QitKLElBQTVCLENBQWlDL0osR0FBakMsQ0FBTCxFQUE0QztBQUMxQyxhQUFPcEUsS0FBS29FLEdBQUwsQ0FBUDtBQUNEO0FBQ0QsV0FBT3BFLElBQVA7QUFDRCxHQU5ZLEVBTVZaLFNBQVMsS0FBS1ksSUFBZCxDQU5VLENBQWI7QUFPQSxTQUFPUixNQUFNNE8sT0FBTixDQUFjbkcsU0FBZCxFQUF5QmpJLElBQXpCLENBQVA7QUFDRCxDQVREOztBQVdBO0FBQ0FMLFVBQVVxQixTQUFWLENBQW9CMkMsa0JBQXBCLEdBQXlDLFVBQVVILFNBQVYsRUFBcUI7QUFDNUQsUUFBTUUsZ0JBQWdCakUsU0FBU21FLE9BQVQsQ0FBaUJKLFNBQWpCLEVBQTRCLEtBQUt2RCxZQUFqQyxDQUF0QjtBQUNBK0UsU0FBT0MsSUFBUCxDQUFZLEtBQUtqRixJQUFqQixFQUF1QmlFLE1BQXZCLENBQThCLFVBQVVqRSxJQUFWLEVBQWdCb0UsR0FBaEIsRUFBcUI7QUFDakQsUUFBSUEsSUFBSXRCLE9BQUosQ0FBWSxHQUFaLElBQW1CLENBQXZCLEVBQTBCO0FBQ3hCO0FBQ0EsWUFBTXVMLGNBQWNqSyxJQUFJa0ssS0FBSixDQUFVLEdBQVYsQ0FBcEI7QUFDQSxZQUFNQyxhQUFhRixZQUFZLENBQVosQ0FBbkI7QUFDQSxVQUFJRyxZQUFZOUssY0FBYytLLEdBQWQsQ0FBa0JGLFVBQWxCLENBQWhCO0FBQ0EsVUFBRyxPQUFPQyxTQUFQLEtBQXFCLFFBQXhCLEVBQWtDO0FBQ2hDQSxvQkFBWSxFQUFaO0FBQ0Q7QUFDREEsZ0JBQVVILFlBQVksQ0FBWixDQUFWLElBQTRCck8sS0FBS29FLEdBQUwsQ0FBNUI7QUFDQVYsb0JBQWNnTCxHQUFkLENBQWtCSCxVQUFsQixFQUE4QkMsU0FBOUI7QUFDQSxhQUFPeE8sS0FBS29FLEdBQUwsQ0FBUDtBQUNEO0FBQ0QsV0FBT3BFLElBQVA7QUFDRCxHQWRELEVBY0daLFNBQVMsS0FBS1ksSUFBZCxDQWRIOztBQWdCQTBELGdCQUFjZ0wsR0FBZCxDQUFrQixLQUFLUixhQUFMLEVBQWxCO0FBQ0EsU0FBT3hLLGFBQVA7QUFDRCxDQXBCRDs7QUFzQkEvRCxVQUFVcUIsU0FBVixDQUFvQm9CLGlCQUFwQixHQUF3QyxZQUFXO0FBQ2pELE1BQUksS0FBS3pCLFFBQUwsSUFBaUIsS0FBS0EsUUFBTCxDQUFjQSxRQUEvQixJQUEyQyxLQUFLYixTQUFMLEtBQW1CLE9BQWxFLEVBQTJFO0FBQ3pFLFVBQU15QyxPQUFPLEtBQUs1QixRQUFMLENBQWNBLFFBQTNCO0FBQ0EsUUFBSTRCLEtBQUttQyxRQUFULEVBQW1CO0FBQ2pCTSxhQUFPQyxJQUFQLENBQVkxQyxLQUFLbUMsUUFBakIsRUFBMkJ1QyxPQUEzQixDQUFvQzNCLFFBQUQsSUFBYztBQUMvQyxZQUFJL0MsS0FBS21DLFFBQUwsQ0FBY1ksUUFBZCxNQUE0QixJQUFoQyxFQUFzQztBQUNwQyxpQkFBTy9DLEtBQUttQyxRQUFMLENBQWNZLFFBQWQsQ0FBUDtBQUNEO0FBQ0YsT0FKRDtBQUtBLFVBQUlOLE9BQU9DLElBQVAsQ0FBWTFDLEtBQUttQyxRQUFqQixFQUEyQlEsTUFBM0IsSUFBcUMsQ0FBekMsRUFBNEM7QUFDMUMsZUFBTzNDLEtBQUttQyxRQUFaO0FBQ0Q7QUFDRjtBQUNGO0FBQ0YsQ0FkRDs7QUFnQkEvRSxVQUFVcUIsU0FBVixDQUFvQm1NLHVCQUFwQixHQUE4QyxVQUFTeE0sUUFBVCxFQUFtQlgsSUFBbkIsRUFBeUI7QUFDckUsTUFBSWdFLGlCQUFFWSxPQUFGLENBQVUsS0FBS3RFLE9BQUwsQ0FBYXlELHNCQUF2QixDQUFKLEVBQW9EO0FBQ2xELFdBQU9wRCxRQUFQO0FBQ0Q7QUFDRCxRQUFNZ08sdUJBQXVCalAsVUFBVWtQLHFCQUFWLENBQWdDLEtBQUsxTyxTQUFyQyxDQUE3QjtBQUNBLE9BQUtJLE9BQUwsQ0FBYXlELHNCQUFiLENBQW9Da0QsT0FBcEMsQ0FBNEM0SCxhQUFhO0FBQ3ZELFVBQU1DLFlBQVk5TyxLQUFLNk8sU0FBTCxDQUFsQjs7QUFFQSxRQUFHLENBQUNsTyxTQUFTb08sY0FBVCxDQUF3QkYsU0FBeEIsQ0FBSixFQUF3QztBQUN0Q2xPLGVBQVNrTyxTQUFULElBQXNCQyxTQUF0QjtBQUNEOztBQUVEO0FBQ0EsUUFBSW5PLFNBQVNrTyxTQUFULEtBQXVCbE8sU0FBU2tPLFNBQVQsRUFBb0JoRyxJQUEvQyxFQUFxRDtBQUNuRCxhQUFPbEksU0FBU2tPLFNBQVQsQ0FBUDtBQUNBLFVBQUlGLHdCQUF3QkcsVUFBVWpHLElBQVYsSUFBa0IsUUFBOUMsRUFBd0Q7QUFDdERsSSxpQkFBU2tPLFNBQVQsSUFBc0JDLFNBQXRCO0FBQ0Q7QUFDRjtBQUNGLEdBZEQ7QUFlQSxTQUFPbk8sUUFBUDtBQUNELENBckJEOztrQkF1QmVoQixTOztBQUNmcVAsT0FBT0MsT0FBUCxHQUFpQnRQLFNBQWpCIiwiZmlsZSI6IlJlc3RXcml0ZS5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8vIEEgUmVzdFdyaXRlIGVuY2Fwc3VsYXRlcyBldmVyeXRoaW5nIHdlIG5lZWQgdG8gcnVuIGFuIG9wZXJhdGlvblxuLy8gdGhhdCB3cml0ZXMgdG8gdGhlIGRhdGFiYXNlLlxuLy8gVGhpcyBjb3VsZCBiZSBlaXRoZXIgYSBcImNyZWF0ZVwiIG9yIGFuIFwidXBkYXRlXCIuXG5cbnZhciBTY2hlbWFDb250cm9sbGVyID0gcmVxdWlyZSgnLi9Db250cm9sbGVycy9TY2hlbWFDb250cm9sbGVyJyk7XG52YXIgZGVlcGNvcHkgPSByZXF1aXJlKCdkZWVwY29weScpO1xuXG5jb25zdCBBdXRoID0gcmVxdWlyZSgnLi9BdXRoJyk7XG52YXIgY3J5cHRvVXRpbHMgPSByZXF1aXJlKCcuL2NyeXB0b1V0aWxzJyk7XG52YXIgcGFzc3dvcmRDcnlwdG8gPSByZXF1aXJlKCcuL3Bhc3N3b3JkJyk7XG52YXIgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJyk7XG52YXIgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG52YXIgQ2xpZW50U0RLID0gcmVxdWlyZSgnLi9DbGllbnRTREsnKTtcbmltcG9ydCBSZXN0UXVlcnkgZnJvbSAnLi9SZXN0UXVlcnknO1xuaW1wb3J0IF8gICAgICAgICBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IGxvZ2dlciAgICBmcm9tICcuL2xvZ2dlcic7XG5cbi8vIHF1ZXJ5IGFuZCBkYXRhIGFyZSBib3RoIHByb3ZpZGVkIGluIFJFU1QgQVBJIGZvcm1hdC4gU28gZGF0YVxuLy8gdHlwZXMgYXJlIGVuY29kZWQgYnkgcGxhaW4gb2xkIG9iamVjdHMuXG4vLyBJZiBxdWVyeSBpcyBudWxsLCB0aGlzIGlzIGEgXCJjcmVhdGVcIiBhbmQgdGhlIGRhdGEgaW4gZGF0YSBzaG91bGQgYmVcbi8vIGNyZWF0ZWQuXG4vLyBPdGhlcndpc2UgdGhpcyBpcyBhbiBcInVwZGF0ZVwiIC0gdGhlIG9iamVjdCBtYXRjaGluZyB0aGUgcXVlcnlcbi8vIHNob3VsZCBnZXQgdXBkYXRlZCB3aXRoIGRhdGEuXG4vLyBSZXN0V3JpdGUgd2lsbCBoYW5kbGUgb2JqZWN0SWQsIGNyZWF0ZWRBdCwgYW5kIHVwZGF0ZWRBdCBmb3Jcbi8vIGV2ZXJ5dGhpbmcuIEl0IGFsc28ga25vd3MgdG8gdXNlIHRyaWdnZXJzIGFuZCBzcGVjaWFsIG1vZGlmaWNhdGlvbnNcbi8vIGZvciB0aGUgX1VzZXIgY2xhc3MuXG5mdW5jdGlvbiBSZXN0V3JpdGUoY29uZmlnLCBhdXRoLCBjbGFzc05hbWUsIHF1ZXJ5LCBkYXRhLCBvcmlnaW5hbERhdGEsIGNsaWVudFNESykge1xuICBpZiAoYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sICdDYW5ub3QgcGVyZm9ybSBhIHdyaXRlIG9wZXJhdGlvbiB3aGVuIHVzaW5nIHJlYWRPbmx5TWFzdGVyS2V5Jyk7XG4gIH1cbiAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gIHRoaXMuYXV0aCA9IGF1dGg7XG4gIHRoaXMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB0aGlzLmNsaWVudFNESyA9IGNsaWVudFNESztcbiAgdGhpcy5zdG9yYWdlID0ge307XG4gIHRoaXMucnVuT3B0aW9ucyA9IHt9O1xuICB0aGlzLmNvbnRleHQgPSB7fTtcbiAgaWYgKCFxdWVyeSAmJiBkYXRhLm9iamVjdElkKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdvYmplY3RJZCBpcyBhbiBpbnZhbGlkIGZpZWxkIG5hbWUuJyk7XG4gIH1cblxuICAvLyBXaGVuIHRoZSBvcGVyYXRpb24gaXMgY29tcGxldGUsIHRoaXMucmVzcG9uc2UgbWF5IGhhdmUgc2V2ZXJhbFxuICAvLyBmaWVsZHMuXG4gIC8vIHJlc3BvbnNlOiB0aGUgYWN0dWFsIGRhdGEgdG8gYmUgcmV0dXJuZWRcbiAgLy8gc3RhdHVzOiB0aGUgaHR0cCBzdGF0dXMgY29kZS4gaWYgbm90IHByZXNlbnQsIHRyZWF0ZWQgbGlrZSBhIDIwMFxuICAvLyBsb2NhdGlvbjogdGhlIGxvY2F0aW9uIGhlYWRlci4gaWYgbm90IHByZXNlbnQsIG5vIGxvY2F0aW9uIGhlYWRlclxuICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcblxuICAvLyBQcm9jZXNzaW5nIHRoaXMgb3BlcmF0aW9uIG1heSBtdXRhdGUgb3VyIGRhdGEsIHNvIHdlIG9wZXJhdGUgb24gYVxuICAvLyBjb3B5XG4gIHRoaXMucXVlcnkgPSBkZWVwY29weShxdWVyeSk7XG4gIHRoaXMuZGF0YSA9IGRlZXBjb3B5KGRhdGEpO1xuICAvLyBXZSBuZXZlciBjaGFuZ2Ugb3JpZ2luYWxEYXRhLCBzbyB3ZSBkbyBub3QgbmVlZCBhIGRlZXAgY29weVxuICB0aGlzLm9yaWdpbmFsRGF0YSA9IG9yaWdpbmFsRGF0YTtcblxuICAvLyBUaGUgdGltZXN0YW1wIHdlJ2xsIHVzZSBmb3IgdGhpcyB3aG9sZSBvcGVyYXRpb25cbiAgdGhpcy51cGRhdGVkQXQgPSBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKCkpLmlzbztcbn1cblxuLy8gQSBjb252ZW5pZW50IG1ldGhvZCB0byBwZXJmb3JtIGFsbCB0aGUgc3RlcHMgb2YgcHJvY2Vzc2luZyB0aGVcbi8vIHdyaXRlLCBpbiBvcmRlci5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIHtyZXNwb25zZSwgc3RhdHVzLCBsb2NhdGlvbn0gb2JqZWN0LlxuLy8gc3RhdHVzIGFuZCBsb2NhdGlvbiBhcmUgb3B0aW9uYWwuXG5SZXN0V3JpdGUucHJvdG90eXBlLmV4ZWN1dGUgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLmdldFVzZXJBbmRSb2xlQUNMKCk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbigpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVJbnN0YWxsYXRpb24oKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMuaGFuZGxlU2Vzc2lvbigpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUF1dGhEYXRhKCk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLnJ1bkJlZm9yZVRyaWdnZXIoKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMudmFsaWRhdGVTY2hlbWEoKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMuc2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCgpO1xuICB9KS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy50cmFuc2Zvcm1Vc2VyKCk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLmV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzKCk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLmRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMoKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMucnVuRGF0YWJhc2VPcGVyYXRpb24oKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQoKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMuaGFuZGxlRm9sbG93dXAoKTtcbiAgfSkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMucnVuQWZ0ZXJUcmlnZ2VyKCk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLmNsZWFuVXNlckF1dGhEYXRhKCk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLnJlc3BvbnNlO1xuICB9KVxufTtcblxuLy8gVXNlcyB0aGUgQXV0aCBvYmplY3QgdG8gZ2V0IHRoZSBsaXN0IG9mIHJvbGVzLCBhZGRzIHRoZSB1c2VyIGlkXG5SZXN0V3JpdGUucHJvdG90eXBlLmdldFVzZXJBbmRSb2xlQUNMID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB0aGlzLnJ1bk9wdGlvbnMuYWNsID0gWycqJ107XG5cbiAgaWYgKHRoaXMuYXV0aC51c2VyKSB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC5nZXRVc2VyUm9sZXMoKS50aGVuKChyb2xlcykgPT4ge1xuICAgICAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IHRoaXMucnVuT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbdGhpcy5hdXRoLnVzZXIuaWRdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuY29uZmlnLmFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiA9PT0gZmFsc2UgJiYgIXRoaXMuYXV0aC5pc01hc3RlclxuICAgICAgJiYgU2NoZW1hQ29udHJvbGxlci5zeXN0ZW1DbGFzc2VzLmluZGV4T2YodGhpcy5jbGFzc05hbWUpID09PSAtMSkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5sb2FkU2NoZW1hKClcbiAgICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5oYXNDbGFzcyh0aGlzLmNsYXNzTmFtZSkpXG4gICAgICAudGhlbihoYXNDbGFzcyA9PiB7XG4gICAgICAgIGlmIChoYXNDbGFzcyAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgJ1RoaXMgdXNlciBpcyBub3QgYWxsb3dlZCB0byBhY2Nlc3MgJyArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdub24tZXhpc3RlbnQgY2xhc3M6ICcgKyB0aGlzLmNsYXNzTmFtZSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIHNjaGVtYS5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVTY2hlbWEgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnZhbGlkYXRlT2JqZWN0KHRoaXMuY2xhc3NOYW1lLCB0aGlzLmRhdGEsIHRoaXMucXVlcnksIHRoaXMucnVuT3B0aW9ucyk7XG59O1xuXG4vLyBSdW5zIGFueSBiZWZvcmVTYXZlIHRyaWdnZXJzIGFnYWluc3QgdGhpcyBvcGVyYXRpb24uXG4vLyBBbnkgY2hhbmdlIGxlYWRzIHRvIG91ciBkYXRhIGJlaW5nIG11dGF0ZWQuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkJlZm9yZVRyaWdnZXIgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdiZWZvcmVTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBpZiAoIXRyaWdnZXJzLnRyaWdnZXJFeGlzdHModGhpcy5jbGFzc05hbWUsIHRyaWdnZXJzLlR5cGVzLmJlZm9yZVNhdmUsIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWQpKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgLy8gQ2xvdWQgY29kZSBnZXRzIGEgYml0IG9mIGV4dHJhIGRhdGEgZm9yIGl0cyBvYmplY3RzXG4gIHZhciBleHRyYURhdGEgPSB7Y2xhc3NOYW1lOiB0aGlzLmNsYXNzTmFtZX07XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBleHRyYURhdGEub2JqZWN0SWQgPSB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICB9XG5cbiAgbGV0IG9yaWdpbmFsT2JqZWN0ID0gbnVsbDtcbiAgY29uc3QgdXBkYXRlZE9iamVjdCA9IHRoaXMuYnVpbGRVcGRhdGVkT2JqZWN0KGV4dHJhRGF0YSk7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAvLyBUaGlzIGlzIGFuIHVwZGF0ZSBmb3IgZXhpc3Rpbmcgb2JqZWN0LlxuICAgIG9yaWdpbmFsT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgfVxuXG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKHRyaWdnZXJzLlR5cGVzLmJlZm9yZVNhdmUsIHRoaXMuYXV0aCwgdXBkYXRlZE9iamVjdCwgb3JpZ2luYWxPYmplY3QsIHRoaXMuY29uZmlnLCB0aGlzLmNvbnRleHQpO1xuICB9KS50aGVuKChyZXNwb25zZSkgPT4ge1xuICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyID0gXy5yZWR1Y2UocmVzcG9uc2Uub2JqZWN0LCAocmVzdWx0LCB2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgIGlmICghXy5pc0VxdWFsKHRoaXMuZGF0YVtrZXldLCB2YWx1ZSkpIHtcbiAgICAgICAgICByZXN1bHQucHVzaChrZXkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICB9LCBbXSk7XG4gICAgICB0aGlzLmRhdGEgPSByZXNwb25zZS5vYmplY3Q7XG4gICAgICAvLyBXZSBzaG91bGQgZGVsZXRlIHRoZSBvYmplY3RJZCBmb3IgYW4gdXBkYXRlIHdyaXRlXG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEub2JqZWN0SWRcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5zZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmRhdGEpIHtcbiAgICAvLyBBZGQgZGVmYXVsdCBmaWVsZHNcbiAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgaWYgKCF0aGlzLnF1ZXJ5KSB7XG4gICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG5cbiAgICAgIC8vIE9ubHkgYXNzaWduIG5ldyBvYmplY3RJZCBpZiB3ZSBhcmUgY3JlYXRpbmcgbmV3IG9iamVjdFxuICAgICAgaWYgKCF0aGlzLmRhdGEub2JqZWN0SWQpIHtcbiAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gY3J5cHRvVXRpbHMubmV3T2JqZWN0SWQodGhpcy5jb25maWcub2JqZWN0SWRTaXplKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuLy8gVHJhbnNmb3JtcyBhdXRoIGRhdGEgZm9yIGEgdXNlciBvYmplY3QuXG4vLyBEb2VzIG5vdGhpbmcgaWYgdGhpcyBpc24ndCBhIHVzZXIgb2JqZWN0LlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUF1dGhEYXRhID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgaWYgKHR5cGVvZiB0aGlzLmRhdGEudXNlcm5hbWUgIT09ICdzdHJpbmcnIHx8IF8uaXNFbXB0eSh0aGlzLmRhdGEudXNlcm5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVVNFUk5BTUVfTUlTU0lORyxcbiAgICAgICAgJ2JhZCBvciBtaXNzaW5nIHVzZXJuYW1lJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdGhpcy5kYXRhLnBhc3N3b3JkICE9PSAnc3RyaW5nJyB8fCBfLmlzRW1wdHkodGhpcy5kYXRhLnBhc3N3b3JkKSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlBBU1NXT1JEX01JU1NJTkcsXG4gICAgICAgICdwYXNzd29yZCBpcyByZXF1aXJlZCcpO1xuICAgIH1cbiAgfVxuXG4gIGlmICghdGhpcy5kYXRhLmF1dGhEYXRhIHx8ICFPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBhdXRoRGF0YSA9IHRoaXMuZGF0YS5hdXRoRGF0YTtcbiAgdmFyIHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgaWYgKHByb3ZpZGVycy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY2FuSGFuZGxlQXV0aERhdGEgPSBwcm92aWRlcnMucmVkdWNlKChjYW5IYW5kbGUsIHByb3ZpZGVyKSA9PiB7XG4gICAgICB2YXIgcHJvdmlkZXJBdXRoRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgIHZhciBoYXNUb2tlbiA9IChwcm92aWRlckF1dGhEYXRhICYmIHByb3ZpZGVyQXV0aERhdGEuaWQpO1xuICAgICAgcmV0dXJuIGNhbkhhbmRsZSAmJiAoaGFzVG9rZW4gfHwgcHJvdmlkZXJBdXRoRGF0YSA9PSBudWxsKTtcbiAgICB9LCB0cnVlKTtcbiAgICBpZiAoY2FuSGFuZGxlQXV0aERhdGEpIHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUF1dGhEYXRhKGF1dGhEYXRhKTtcbiAgICB9XG4gIH1cbiAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlVOU1VQUE9SVEVEX1NFUlZJQ0UsXG4gICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLicpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24gPSBmdW5jdGlvbihhdXRoRGF0YSkge1xuICBjb25zdCB2YWxpZGF0aW9ucyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKS5tYXAoKHByb3ZpZGVyKSA9PiB7XG4gICAgaWYgKGF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICBjb25zdCB2YWxpZGF0ZUF1dGhEYXRhID0gdGhpcy5jb25maWcuYXV0aERhdGFNYW5hZ2VyLmdldFZhbGlkYXRvckZvclByb3ZpZGVyKHByb3ZpZGVyKTtcbiAgICBpZiAoIXZhbGlkYXRlQXV0aERhdGEpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICAgICAnVGhpcyBhdXRoZW50aWNhdGlvbiBtZXRob2QgaXMgdW5zdXBwb3J0ZWQuJyk7XG4gICAgfVxuICAgIHJldHVybiB2YWxpZGF0ZUF1dGhEYXRhKGF1dGhEYXRhW3Byb3ZpZGVyXSk7XG4gIH0pO1xuICByZXR1cm4gUHJvbWlzZS5hbGwodmFsaWRhdGlvbnMpO1xufVxuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbmRVc2Vyc1dpdGhBdXRoRGF0YSA9IGZ1bmN0aW9uKGF1dGhEYXRhKSB7XG4gIGNvbnN0IHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgY29uc3QgcXVlcnkgPSBwcm92aWRlcnMucmVkdWNlKChtZW1vLCBwcm92aWRlcikgPT4ge1xuICAgIGlmICghYXV0aERhdGFbcHJvdmlkZXJdKSB7XG4gICAgICByZXR1cm4gbWVtbztcbiAgICB9XG4gICAgY29uc3QgcXVlcnlLZXkgPSBgYXV0aERhdGEuJHtwcm92aWRlcn0uaWRgO1xuICAgIGNvbnN0IHF1ZXJ5ID0ge307XG4gICAgcXVlcnlbcXVlcnlLZXldID0gYXV0aERhdGFbcHJvdmlkZXJdLmlkO1xuICAgIG1lbW8ucHVzaChxdWVyeSk7XG4gICAgcmV0dXJuIG1lbW87XG4gIH0sIFtdKS5maWx0ZXIoKHEpID0+IHtcbiAgICByZXR1cm4gdHlwZW9mIHEgIT09ICd1bmRlZmluZWQnO1xuICB9KTtcblxuICBsZXQgZmluZFByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoW10pO1xuICBpZiAocXVlcnkubGVuZ3RoID4gMCkge1xuICAgIGZpbmRQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgeyckb3InOiBxdWVyeX0sIHt9KVxuICB9XG5cbiAgcmV0dXJuIGZpbmRQcm9taXNlO1xufVxuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbHRlcmVkT2JqZWN0c0J5QUNMID0gZnVuY3Rpb24ob2JqZWN0cykge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIG9iamVjdHM7XG4gIH1cbiAgcmV0dXJuIG9iamVjdHMuZmlsdGVyKChvYmplY3QpID0+IHtcbiAgICBpZiAoIW9iamVjdC5BQ0wpIHtcbiAgICAgIHJldHVybiB0cnVlOyAvLyBsZWdhY3kgdXNlcnMgdGhhdCBoYXZlIG5vIEFDTCBmaWVsZCBvbiB0aGVtXG4gICAgfVxuICAgIC8vIFJlZ3VsYXIgdXNlcnMgdGhhdCBoYXZlIGJlZW4gbG9ja2VkIG91dC5cbiAgICByZXR1cm4gb2JqZWN0LkFDTCAmJiBPYmplY3Qua2V5cyhvYmplY3QuQUNMKS5sZW5ndGggPiAwO1xuICB9KTtcbn1cblxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVBdXRoRGF0YSA9IGZ1bmN0aW9uKGF1dGhEYXRhKSB7XG4gIGxldCByZXN1bHRzO1xuICByZXR1cm4gdGhpcy5maW5kVXNlcnNXaXRoQXV0aERhdGEoYXV0aERhdGEpLnRoZW4oKHIpID0+IHtcbiAgICByZXN1bHRzID0gdGhpcy5maWx0ZXJlZE9iamVjdHNCeUFDTChyKTtcbiAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAxKSB7XG4gICAgICAvLyBNb3JlIHRoYW4gMSB1c2VyIHdpdGggdGhlIHBhc3NlZCBpZCdzXG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuQUNDT1VOVF9BTFJFQURZX0xJTktFRCxcbiAgICAgICAgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnKTtcbiAgICB9XG5cbiAgICB0aGlzLnN0b3JhZ2VbJ2F1dGhQcm92aWRlciddID0gT2JqZWN0LmtleXMoYXV0aERhdGEpLmpvaW4oJywnKTtcblxuICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHVzZXJSZXN1bHQgPSByZXN1bHRzWzBdO1xuICAgICAgY29uc3QgbXV0YXRlZEF1dGhEYXRhID0ge307XG4gICAgICBPYmplY3Qua2V5cyhhdXRoRGF0YSkuZm9yRWFjaCgocHJvdmlkZXIpID0+IHtcbiAgICAgICAgY29uc3QgcHJvdmlkZXJEYXRhID0gYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICBjb25zdCB1c2VyQXV0aERhdGEgPSB1c2VyUmVzdWx0LmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgaWYgKCFfLmlzRXF1YWwocHJvdmlkZXJEYXRhLCB1c2VyQXV0aERhdGEpKSB7XG4gICAgICAgICAgbXV0YXRlZEF1dGhEYXRhW3Byb3ZpZGVyXSA9IHByb3ZpZGVyRGF0YTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBjb25zdCBoYXNNdXRhdGVkQXV0aERhdGEgPSBPYmplY3Qua2V5cyhtdXRhdGVkQXV0aERhdGEpLmxlbmd0aCAhPT0gMDtcbiAgICAgIGxldCB1c2VySWQ7XG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgIHVzZXJJZCA9IHRoaXMucXVlcnkub2JqZWN0SWQ7XG4gICAgICB9IGVsc2UgaWYgKHRoaXMuYXV0aCAmJiB0aGlzLmF1dGgudXNlciAmJiB0aGlzLmF1dGgudXNlci5pZCkge1xuICAgICAgICB1c2VySWQgPSB0aGlzLmF1dGgudXNlci5pZDtcbiAgICAgIH1cbiAgICAgIGlmICghdXNlcklkIHx8IHVzZXJJZCA9PT0gdXNlclJlc3VsdC5vYmplY3RJZCkgeyAvLyBubyB1c2VyIG1ha2luZyB0aGUgY2FsbFxuICAgICAgICAvLyBPUiB0aGUgdXNlciBtYWtpbmcgdGhlIGNhbGwgaXMgdGhlIHJpZ2h0IG9uZVxuICAgICAgICAvLyBMb2dpbiB3aXRoIGF1dGggZGF0YVxuICAgICAgICBkZWxldGUgcmVzdWx0c1swXS5wYXNzd29yZDtcblxuICAgICAgICAvLyBuZWVkIHRvIHNldCB0aGUgb2JqZWN0SWQgZmlyc3Qgb3RoZXJ3aXNlIGxvY2F0aW9uIGhhcyB0cmFpbGluZyB1bmRlZmluZWRcbiAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkID0gdXNlclJlc3VsdC5vYmplY3RJZDtcblxuICAgICAgICBpZiAoIXRoaXMucXVlcnkgfHwgIXRoaXMucXVlcnkub2JqZWN0SWQpIHsgLy8gdGhpcyBhIGxvZ2luIGNhbGwsIG5vIHVzZXJJZCBwYXNzZWRcbiAgICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgICAgcmVzcG9uc2U6IHVzZXJSZXN1bHQsXG4gICAgICAgICAgICBsb2NhdGlvbjogdGhpcy5sb2NhdGlvbigpXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICAvLyBJZiB3ZSBkaWRuJ3QgY2hhbmdlIHRoZSBhdXRoIGRhdGEsIGp1c3Qga2VlcCBnb2luZ1xuICAgICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICAvLyBXZSBoYXZlIGF1dGhEYXRhIHRoYXQgaXMgdXBkYXRlZCBvbiBsb2dpblxuICAgICAgICAvLyB0aGF0IGNhbiBoYXBwZW4gd2hlbiB0b2tlbiBhcmUgcmVmcmVzaGVkLFxuICAgICAgICAvLyBXZSBzaG91bGQgdXBkYXRlIHRoZSB0b2tlbiBhbmQgbGV0IHRoZSB1c2VyIGluXG4gICAgICAgIC8vIFdlIHNob3VsZCBvbmx5IGNoZWNrIHRoZSBtdXRhdGVkIGtleXNcbiAgICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKG11dGF0ZWRBdXRoRGF0YSkudGhlbigoKSA9PiB7XG4gICAgICAgICAgLy8gSUYgd2UgaGF2ZSBhIHJlc3BvbnNlLCB3ZSdsbCBza2lwIHRoZSBkYXRhYmFzZSBvcGVyYXRpb24gLyBiZWZvcmVTYXZlIC8gYWZ0ZXJTYXZlIGV0Yy4uLlxuICAgICAgICAgIC8vIHdlIG5lZWQgdG8gc2V0IGl0IHVwIHRoZXJlLlxuICAgICAgICAgIC8vIFdlIGFyZSBzdXBwb3NlZCB0byBoYXZlIGEgcmVzcG9uc2Ugb25seSBvbiBMT0dJTiB3aXRoIGF1dGhEYXRhLCBzbyB3ZSBza2lwIHRob3NlXG4gICAgICAgICAgLy8gSWYgd2UncmUgbm90IGxvZ2dpbmcgaW4sIGJ1dCBqdXN0IHVwZGF0aW5nIHRoZSBjdXJyZW50IHVzZXIsIHdlIGNhbiBzYWZlbHkgc2tpcCB0aGF0IHBhcnRcbiAgICAgICAgICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgICAgICAgICAgLy8gQXNzaWduIHRoZSBuZXcgYXV0aERhdGEgaW4gdGhlIHJlc3BvbnNlXG4gICAgICAgICAgICBPYmplY3Qua2V5cyhtdXRhdGVkQXV0aERhdGEpLmZvckVhY2goKHByb3ZpZGVyKSA9PiB7XG4gICAgICAgICAgICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UuYXV0aERhdGFbcHJvdmlkZXJdID0gbXV0YXRlZEF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgLy8gUnVuIHRoZSBEQiB1cGRhdGUgZGlyZWN0bHksIGFzICdtYXN0ZXInXG4gICAgICAgICAgICAvLyBKdXN0IHVwZGF0ZSB0aGUgYXV0aERhdGEgcGFydFxuICAgICAgICAgICAgLy8gVGhlbiB3ZSdyZSBnb29kIGZvciB0aGUgdXNlciwgZWFybHkgZXhpdCBvZiBzb3J0c1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZSh0aGlzLmNsYXNzTmFtZSwge29iamVjdElkOiB0aGlzLmRhdGEub2JqZWN0SWR9LCB7YXV0aERhdGE6IG11dGF0ZWRBdXRoRGF0YX0sIHt9KTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmICh1c2VySWQpIHtcbiAgICAgICAgLy8gVHJ5aW5nIHRvIHVwZGF0ZSBhdXRoIGRhdGEgYnV0IHVzZXJzXG4gICAgICAgIC8vIGFyZSBkaWZmZXJlbnRcbiAgICAgICAgaWYgKHVzZXJSZXN1bHQub2JqZWN0SWQgIT09IHVzZXJJZCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELFxuICAgICAgICAgICAgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBObyBhdXRoIGRhdGEgd2FzIG11dGF0ZWQsIGp1c3Qga2VlcCBnb2luZ1xuICAgICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24oYXV0aERhdGEpO1xuICB9KTtcbn1cblxuXG4vLyBUaGUgbm9uLXRoaXJkLXBhcnR5IHBhcnRzIG9mIFVzZXIgdHJhbnNmb3JtYXRpb25cblJlc3RXcml0ZS5wcm90b3R5cGUudHJhbnNmb3JtVXNlciA9IGZ1bmN0aW9uKCkge1xuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgXCJlbWFpbFZlcmlmaWVkXCIgaW4gdGhpcy5kYXRhKSB7XG4gICAgY29uc3QgZXJyb3IgPSBgQ2xpZW50cyBhcmVuJ3QgYWxsb3dlZCB0byBtYW51YWxseSB1cGRhdGUgZW1haWwgdmVyaWZpY2F0aW9uLmBcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTiwgZXJyb3IpO1xuICB9XG5cbiAgLy8gRG8gbm90IGNsZWFudXAgc2Vzc2lvbiBpZiBvYmplY3RJZCBpcyBub3Qgc2V0XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMub2JqZWN0SWQoKSkge1xuICAgIC8vIElmIHdlJ3JlIHVwZGF0aW5nIGEgX1VzZXIgb2JqZWN0LCB3ZSBuZWVkIHRvIGNsZWFyIG91dCB0aGUgY2FjaGUgZm9yIHRoYXQgdXNlci4gRmluZCBhbGwgdGhlaXJcbiAgICAvLyBzZXNzaW9uIHRva2VucywgYW5kIHJlbW92ZSB0aGVtIGZyb20gdGhlIGNhY2hlLlxuICAgIHByb21pc2UgPSBuZXcgUmVzdFF1ZXJ5KHRoaXMuY29uZmlnLCBBdXRoLm1hc3Rlcih0aGlzLmNvbmZpZyksICdfU2Vzc2lvbicsIHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiBcIlBvaW50ZXJcIixcbiAgICAgICAgY2xhc3NOYW1lOiBcIl9Vc2VyXCIsXG4gICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICB9XG4gICAgfSkuZXhlY3V0ZSgpXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgcmVzdWx0cy5yZXN1bHRzLmZvckVhY2goc2Vzc2lvbiA9PiB0aGlzLmNvbmZpZy5jYWNoZUNvbnRyb2xsZXIudXNlci5kZWwoc2Vzc2lvbi5zZXNzaW9uVG9rZW4pKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHByb21pc2UudGhlbigoKSA9PiB7XG4gICAgLy8gVHJhbnNmb3JtIHRoZSBwYXNzd29yZFxuICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQgPT09IHVuZGVmaW5lZCkgeyAvLyBpZ25vcmUgb25seSBpZiB1bmRlZmluZWQuIHNob3VsZCBwcm9jZWVkIGlmIGVtcHR5ICgnJylcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ10gPSB0cnVlO1xuICAgICAgLy8gR2VuZXJhdGUgYSBuZXcgc2Vzc2lvbiBvbmx5IGlmIHRoZSB1c2VyIHJlcXVlc3RlZFxuICAgICAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICAgICAgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXSA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3koKS50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiBwYXNzd29yZENyeXB0by5oYXNoKHRoaXMuZGF0YS5wYXNzd29yZCkudGhlbigoaGFzaGVkUGFzc3dvcmQpID0+IHtcbiAgICAgICAgdGhpcy5kYXRhLl9oYXNoZWRfcGFzc3dvcmQgPSBoYXNoZWRQYXNzd29yZDtcbiAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVVzZXJOYW1lKCk7XG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZUVtYWlsKCk7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVVc2VyTmFtZSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gQ2hlY2sgZm9yIHVzZXJuYW1lIHVuaXF1ZW5lc3NcbiAgaWYgKCF0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgIHRoaXMuZGF0YS51c2VybmFtZSA9IGNyeXB0b1V0aWxzLnJhbmRvbVN0cmluZygyNSk7XG4gICAgICB0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFdlIG5lZWQgdG8gYSBmaW5kIHRvIGNoZWNrIGZvciBkdXBsaWNhdGUgdXNlcm5hbWUgaW4gY2FzZSB0aGV5IGFyZSBtaXNzaW5nIHRoZSB1bmlxdWUgaW5kZXggb24gdXNlcm5hbWVzXG4gIC8vIFRPRE86IENoZWNrIGlmIHRoZXJlIGlzIGEgdW5pcXVlIGluZGV4LCBhbmQgaWYgc28sIHNraXAgdGhpcyBxdWVyeS5cbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAge3VzZXJuYW1lOiB0aGlzLmRhdGEudXNlcm5hbWUsIG9iamVjdElkOiB7JyRuZSc6IHRoaXMub2JqZWN0SWQoKX19LFxuICAgIHtsaW1pdDogMX1cbiAgKS50aGVuKHJlc3VsdHMgPT4ge1xuICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTiwgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJyk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZUVtYWlsID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5kYXRhLmVtYWlsIHx8IHRoaXMuZGF0YS5lbWFpbC5fX29wID09PSAnRGVsZXRlJykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBWYWxpZGF0ZSBiYXNpYyBlbWFpbCBhZGRyZXNzIGZvcm1hdFxuICBpZiAoIXRoaXMuZGF0YS5lbWFpbC5tYXRjaCgvXi4rQC4rJC8pKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0VNQUlMX0FERFJFU1MsICdFbWFpbCBhZGRyZXNzIGZvcm1hdCBpcyBpbnZhbGlkLicpKTtcbiAgfVxuICAvLyBTYW1lIHByb2JsZW0gZm9yIGVtYWlsIGFzIGFib3ZlIGZvciB1c2VybmFtZVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB7ZW1haWw6IHRoaXMuZGF0YS5lbWFpbCwgb2JqZWN0SWQ6IHsnJG5lJzogdGhpcy5vYmplY3RJZCgpfX0sXG4gICAge2xpbWl0OiAxfVxuICApLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLCAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLicpO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICAhdGhpcy5kYXRhLmF1dGhEYXRhIHx8XG4gICAgICAhT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGggfHxcbiAgICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoID09PSAxICYmIE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSlbMF0gPT09ICdhbm9ueW1vdXMnXG4gICAgKSB7XG4gICAgICAvLyBXZSB1cGRhdGVkIHRoZSBlbWFpbCwgc2VuZCBhIG5ldyB2YWxpZGF0aW9uXG4gICAgICB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddID0gdHJ1ZTtcbiAgICAgIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNldEVtYWlsVmVyaWZ5VG9rZW4odGhpcy5kYXRhKTtcbiAgICB9XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5KVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMoKS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkoKTtcbiAgfSk7XG59O1xuXG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMgPSBmdW5jdGlvbigpIHtcbiAgLy8gY2hlY2sgaWYgdGhlIHBhc3N3b3JkIGNvbmZvcm1zIHRvIHRoZSBkZWZpbmVkIHBhc3N3b3JkIHBvbGljeSBpZiBjb25maWd1cmVkXG4gIGNvbnN0IHBvbGljeUVycm9yID0gJ1Bhc3N3b3JkIGRvZXMgbm90IG1lZXQgdGhlIFBhc3N3b3JkIFBvbGljeSByZXF1aXJlbWVudHMuJztcblxuICAvLyBjaGVjayB3aGV0aGVyIHRoZSBwYXNzd29yZCBtZWV0cyB0aGUgcGFzc3dvcmQgc3RyZW5ndGggcmVxdWlyZW1lbnRzXG4gIGlmICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yICYmICF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yKHRoaXMuZGF0YS5wYXNzd29yZCkgfHxcbiAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayAmJiAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sodGhpcy5kYXRhLnBhc3N3b3JkKSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUiwgcG9saWN5RXJyb3IpKTtcbiAgfVxuXG4gIC8vIGNoZWNrIHdoZXRoZXIgcGFzc3dvcmQgY29udGFpbiB1c2VybmFtZVxuICBpZiAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kuZG9Ob3RBbGxvd1VzZXJuYW1lID09PSB0cnVlKSB7XG4gICAgaWYgKHRoaXMuZGF0YS51c2VybmFtZSkgeyAvLyB1c2VybmFtZSBpcyBub3QgcGFzc2VkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHRoaXMuZGF0YS51c2VybmFtZSkgPj0gMClcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBwb2xpY3lFcnJvcikpO1xuICAgIH0gZWxzZSB7IC8vIHJldHJpZXZlIHRoZSBVc2VyIG9iamVjdCB1c2luZyBvYmplY3RJZCBkdXJpbmcgcGFzc3dvcmQgcmVzZXRcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKCdfVXNlcicsIHtvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpfSlcbiAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICAgIHRocm93IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHJlc3VsdHNbMF0udXNlcm5hbWUpID49IDApXG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIHBvbGljeUVycm9yKSk7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkgPSBmdW5jdGlvbigpIHtcbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBpcyByZXBlYXRpbmcgZnJvbSBzcGVjaWZpZWQgaGlzdG9yeVxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkpIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCB7b2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKX0sIHtrZXlzOiBbXCJfcGFzc3dvcmRfaGlzdG9yeVwiLCBcIl9oYXNoZWRfcGFzc3dvcmRcIl19KVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICBsZXQgb2xkUGFzc3dvcmRzID0gW107XG4gICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KVxuICAgICAgICAgIG9sZFBhc3N3b3JkcyA9IF8udGFrZSh1c2VyLl9wYXNzd29yZF9oaXN0b3J5LCB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgLSAxKTtcbiAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgIGNvbnN0IG5ld1Bhc3N3b3JkID0gdGhpcy5kYXRhLnBhc3N3b3JkO1xuICAgICAgICAvLyBjb21wYXJlIHRoZSBuZXcgcGFzc3dvcmQgaGFzaCB3aXRoIGFsbCBvbGQgcGFzc3dvcmQgaGFzaGVzXG4gICAgICAgIGNvbnN0IHByb21pc2VzID0gb2xkUGFzc3dvcmRzLm1hcChmdW5jdGlvbiAoaGFzaCkge1xuICAgICAgICAgIHJldHVybiBwYXNzd29yZENyeXB0by5jb21wYXJlKG5ld1Bhc3N3b3JkLCBoYXNoKS50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHQpIC8vIHJlamVjdCBpZiB0aGVyZSBpcyBhIG1hdGNoXG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcIlJFUEVBVF9QQVNTV09SRFwiKTtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9KVxuICAgICAgICB9KTtcbiAgICAgICAgLy8gd2FpdCBmb3IgYWxsIGNvbXBhcmlzb25zIHRvIGNvbXBsZXRlXG4gICAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcykudGhlbigoKSA9PiB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9KS5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgIGlmIChlcnIgPT09IFwiUkVQRUFUX1BBU1NXT1JEXCIpIC8vIGEgbWF0Y2ggd2FzIGZvdW5kXG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIGBOZXcgcGFzc3dvcmQgc2hvdWxkIG5vdCBiZSB0aGUgc2FtZSBhcyBsYXN0ICR7dGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5fSBwYXNzd29yZHMuYCkpO1xuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodGhpcy5xdWVyeSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXRoaXMuc3RvcmFnZVsnYXV0aFByb3ZpZGVyJ10gLy8gc2lnbnVwIGNhbGwsIHdpdGhcbiAgICAgICYmIHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgLy8gbm8gbG9naW4gd2l0aG91dCB2ZXJpZmljYXRpb25cbiAgICAgICYmIHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHMpIHsgLy8gdmVyaWZpY2F0aW9uIGlzIG9uXG4gICAgcmV0dXJuOyAvLyBkbyBub3QgY3JlYXRlIHRoZSBzZXNzaW9uIHRva2VuIGluIHRoYXQgY2FzZSFcbiAgfVxuICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW4oKTtcbn1cblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jcmVhdGVTZXNzaW9uVG9rZW4gPSBmdW5jdGlvbigpIHtcbiAgLy8gY2xvdWQgaW5zdGFsbGF0aW9uSWQgZnJvbSBDbG91ZCBDb2RlLFxuICAvLyBuZXZlciBjcmVhdGUgc2Vzc2lvbiB0b2tlbnMgZnJvbSB0aGVyZS5cbiAgaWYgKHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCAmJiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQgPT09ICdjbG91ZCcpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB7XG4gICAgc2Vzc2lvbkRhdGEsXG4gICAgY3JlYXRlU2Vzc2lvbixcbiAgfSA9IEF1dGguY3JlYXRlU2Vzc2lvbih0aGlzLmNvbmZpZywge1xuICAgIHVzZXJJZDogdGhpcy5vYmplY3RJZCgpLFxuICAgIGNyZWF0ZWRXaXRoOiB7XG4gICAgICAnYWN0aW9uJzogdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSA/ICdsb2dpbicgOiAnc2lnbnVwJyxcbiAgICAgICdhdXRoUHJvdmlkZXInOiB0aGlzLnN0b3JhZ2VbJ2F1dGhQcm92aWRlciddIHx8ICdwYXNzd29yZCdcbiAgICB9LFxuICAgIGluc3RhbGxhdGlvbklkOiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gIH0pO1xuXG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLnNlc3Npb25Ub2tlbiA9IHNlc3Npb25EYXRhLnNlc3Npb25Ub2tlbjtcbiAgfVxuXG4gIHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG59XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucyA9IGZ1bmN0aW9uKCkge1xuICAvLyBPbmx5IGZvciBfU2Vzc2lvbiwgYW5kIGF0IGNyZWF0aW9uIHRpbWVcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9ICdfU2Vzc2lvbicgfHwgdGhpcy5xdWVyeSkge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEZXN0cm95IHRoZSBzZXNzaW9ucyBpbiAnQmFja2dyb3VuZCdcbiAgY29uc3Qge1xuICAgIHVzZXIsXG4gICAgaW5zdGFsbGF0aW9uSWQsXG4gICAgc2Vzc2lvblRva2VuLFxuICB9ID0gdGhpcy5kYXRhO1xuICBpZiAoIXVzZXIgfHwgIWluc3RhbGxhdGlvbklkKSAge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXVzZXIub2JqZWN0SWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveSgnX1Nlc3Npb24nLCB7XG4gICAgdXNlcixcbiAgICBpbnN0YWxsYXRpb25JZCxcbiAgICBzZXNzaW9uVG9rZW46IHsgJyRuZSc6IHNlc3Npb25Ub2tlbiB9LFxuICB9KTtcbn1cblxuLy8gSGFuZGxlcyBhbnkgZm9sbG93dXAgbG9naWNcblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlRm9sbG93dXAgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSAmJiB0aGlzLmNvbmZpZy5yZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0KSB7XG4gICAgdmFyIHNlc3Npb25RdWVyeSA9IHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKVxuICAgICAgfVxuICAgIH07XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddO1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5kZXN0cm95KCdfU2Vzc2lvbicsIHNlc3Npb25RdWVyeSlcbiAgICAgIC50aGVuKHRoaXMuaGFuZGxlRm9sbG93dXAuYmluZCh0aGlzKSk7XG4gIH1cblxuICBpZiAodGhpcy5zdG9yYWdlICYmIHRoaXMuc3RvcmFnZVsnZ2VuZXJhdGVOZXdTZXNzaW9uJ10pIHtcbiAgICBkZWxldGUgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW4oKVxuICAgICAgLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydzZW5kVmVyaWZpY2F0aW9uRW1haWwnXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddO1xuICAgIC8vIEZpcmUgYW5kIGZvcmdldCFcbiAgICB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZW5kVmVyaWZpY2F0aW9uRW1haWwodGhpcy5kYXRhKTtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfU2Vzc2lvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIF9TZXNzaW9uIG9iamVjdC5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlU2Vzc2lvbiA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLmNsYXNzTmFtZSAhPT0gJ19TZXNzaW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLnVzZXIgJiYgIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sXG4gICAgICAnU2Vzc2lvbiB0b2tlbiByZXF1aXJlZC4nKTtcbiAgfVxuXG4gIC8vIFRPRE86IFZlcmlmeSBwcm9wZXIgZXJyb3IgdG8gdGhyb3dcbiAgaWYgKHRoaXMuZGF0YS5BQ0wpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ0Nhbm5vdCBzZXQgJyArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICdBQ0wgb24gYSBTZXNzaW9uLicpO1xuICB9XG5cbiAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICBpZiAodGhpcy5kYXRhLnVzZXIgJiYgIXRoaXMuYXV0aC5pc01hc3RlciAmJiB0aGlzLmRhdGEudXNlci5vYmplY3RJZCAhPSB0aGlzLmF1dGgudXNlci5pZCkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmRhdGEuc2Vzc2lvblRva2VuKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICBjb25zdCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEgPSB7fTtcbiAgICBmb3IgKHZhciBrZXkgaW4gdGhpcy5kYXRhKSB7XG4gICAgICBpZiAoa2V5ID09PSAnb2JqZWN0SWQnIHx8IGtleSA9PT0gJ3VzZXInKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYWRkaXRpb25hbFNlc3Npb25EYXRhW2tleV0gPSB0aGlzLmRhdGFba2V5XTtcbiAgICB9XG5cbiAgICBjb25zdCB7IHNlc3Npb25EYXRhLCBjcmVhdGVTZXNzaW9uIH0gPSBBdXRoLmNyZWF0ZVNlc3Npb24odGhpcy5jb25maWcsIHtcbiAgICAgIHVzZXJJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICBjcmVhdGVkV2l0aDoge1xuICAgICAgICBhY3Rpb246ICdjcmVhdGUnLFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxTZXNzaW9uRGF0YVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKS50aGVuKChyZXN1bHRzKSA9PiB7XG4gICAgICBpZiAoIXJlc3VsdHMucmVzcG9uc2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUixcbiAgICAgICAgICAnRXJyb3IgY3JlYXRpbmcgc2Vzc2lvbi4nKTtcbiAgICAgIH1cbiAgICAgIHNlc3Npb25EYXRhWydvYmplY3RJZCddID0gcmVzdWx0cy5yZXNwb25zZVsnb2JqZWN0SWQnXTtcbiAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICBsb2NhdGlvbjogcmVzdWx0cy5sb2NhdGlvbixcbiAgICAgICAgcmVzcG9uc2U6IHNlc3Npb25EYXRhXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfSW5zdGFsbGF0aW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gaW5zdGFsbGF0aW9uIG9iamVjdC5cbi8vIElmIGFuIGluc3RhbGxhdGlvbiBpcyBmb3VuZCwgdGhpcyBjYW4gbXV0YXRlIHRoaXMucXVlcnkgYW5kIHR1cm4gYSBjcmVhdGVcbi8vIGludG8gYW4gdXBkYXRlLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVJbnN0YWxsYXRpb24gPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5jbGFzc05hbWUgIT09ICdfSW5zdGFsbGF0aW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiYgIXRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzUsXG4gICAgICAnYXQgbGVhc3Qgb25lIElEIGZpZWxkIChkZXZpY2VUb2tlbiwgaW5zdGFsbGF0aW9uSWQpICcgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAnbXVzdCBiZSBzcGVjaWZpZWQgaW4gdGhpcyBvcGVyYXRpb24nKTtcbiAgfVxuXG4gIC8vIElmIHRoZSBkZXZpY2UgdG9rZW4gaXMgNjQgY2hhcmFjdGVycyBsb25nLCB3ZSBhc3N1bWUgaXQgaXMgZm9yIGlPU1xuICAvLyBhbmQgbG93ZXJjYXNlIGl0LlxuICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuICYmIHRoaXMuZGF0YS5kZXZpY2VUb2tlbi5sZW5ndGggPT0gNjQpIHtcbiAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4udG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIC8vIFdlIGxvd2VyY2FzZSB0aGUgaW5zdGFsbGF0aW9uSWQgaWYgcHJlc2VudFxuICBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkID0gdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICBsZXQgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQ7XG5cbiAgLy8gSWYgZGF0YS5pbnN0YWxsYXRpb25JZCBpcyBub3Qgc2V0IGFuZCB3ZSdyZSBub3QgbWFzdGVyLCB3ZSBjYW4gbG9va3VwIGluIGF1dGhcbiAgaWYgKCFpbnN0YWxsYXRpb25JZCAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBpbnN0YWxsYXRpb25JZCA9IGluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBVcGRhdGluZyBfSW5zdGFsbGF0aW9uIGJ1dCBub3QgdXBkYXRpbmcgYW55dGhpbmcgY3JpdGljYWxcbiAgaWYgKHRoaXMucXVlcnkgJiYgIXRoaXMuZGF0YS5kZXZpY2VUb2tlblxuICAgICAgICAgICAgICAgICAgJiYgIWluc3RhbGxhdGlvbklkICYmICF0aGlzLmRhdGEuZGV2aWNlVHlwZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbiAgdmFyIGlkTWF0Y2g7IC8vIFdpbGwgYmUgYSBtYXRjaCBvbiBlaXRoZXIgb2JqZWN0SWQgb3IgaW5zdGFsbGF0aW9uSWRcbiAgdmFyIG9iamVjdElkTWF0Y2g7XG4gIHZhciBpbnN0YWxsYXRpb25JZE1hdGNoO1xuICB2YXIgZGV2aWNlVG9rZW5NYXRjaGVzID0gW107XG5cbiAgLy8gSW5zdGVhZCBvZiBpc3N1aW5nIDMgcmVhZHMsIGxldCdzIGRvIGl0IHdpdGggb25lIE9SLlxuICBjb25zdCBvclF1ZXJpZXMgPSBbXTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIG9yUXVlcmllcy5wdXNoKHtcbiAgICAgIG9iamVjdElkOiB0aGlzLnF1ZXJ5Lm9iamVjdElkXG4gICAgfSk7XG4gIH1cbiAgaWYgKGluc3RhbGxhdGlvbklkKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goe1xuICAgICAgJ2luc3RhbGxhdGlvbklkJzogaW5zdGFsbGF0aW9uSWRcbiAgICB9KTtcbiAgfVxuICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goeydkZXZpY2VUb2tlbic6IHRoaXMuZGF0YS5kZXZpY2VUb2tlbn0pO1xuICB9XG5cbiAgaWYgKG9yUXVlcmllcy5sZW5ndGggPT0gMCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHByb21pc2UgPSBwcm9taXNlLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKCdfSW5zdGFsbGF0aW9uJywge1xuICAgICAgJyRvcic6IG9yUXVlcmllc1xuICAgIH0sIHt9KTtcbiAgfSkudGhlbigocmVzdWx0cykgPT4ge1xuICAgIHJlc3VsdHMuZm9yRWFjaCgocmVzdWx0KSA9PiB7XG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIHJlc3VsdC5vYmplY3RJZCA9PSB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgIG9iamVjdElkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICB9XG4gICAgICBpZiAocmVzdWx0Lmluc3RhbGxhdGlvbklkID09IGluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgIGluc3RhbGxhdGlvbklkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICB9XG4gICAgICBpZiAocmVzdWx0LmRldmljZVRva2VuID09IHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMucHVzaChyZXN1bHQpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gU2FuaXR5IGNoZWNrcyB3aGVuIHJ1bm5pbmcgYSBxdWVyeVxuICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgIGlmICghb2JqZWN0SWRNYXRjaCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAnT2JqZWN0IG5vdCBmb3VuZCBmb3IgdXBkYXRlLicpO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJiBvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICE9PSBvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsXG4gICAgICAgICAgJ2luc3RhbGxhdGlvbklkIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnb3BlcmF0aW9uJyk7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuICYmIG9iamVjdElkTWF0Y2guZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gIT09IG9iamVjdElkTWF0Y2guZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICAhdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmICFvYmplY3RJZE1hdGNoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsXG4gICAgICAgICAgJ2RldmljZVRva2VuIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnb3BlcmF0aW9uJyk7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5kYXRhLmRldmljZVR5cGUgJiYgdGhpcy5kYXRhLmRldmljZVR5cGUgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAhPT0gb2JqZWN0SWRNYXRjaC5kZXZpY2VUeXBlKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsXG4gICAgICAgICAgJ2RldmljZVR5cGUgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdvcGVyYXRpb24nKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIG9iamVjdElkTWF0Y2gpIHtcbiAgICAgIGlkTWF0Y2ggPSBvYmplY3RJZE1hdGNoO1xuICAgIH1cblxuICAgIGlmIChpbnN0YWxsYXRpb25JZCAmJiBpbnN0YWxsYXRpb25JZE1hdGNoKSB7XG4gICAgICBpZE1hdGNoID0gaW5zdGFsbGF0aW9uSWRNYXRjaDtcbiAgICB9XG4gICAgLy8gbmVlZCB0byBzcGVjaWZ5IGRldmljZVR5cGUgb25seSBpZiBpdCdzIG5ld1xuICAgIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmRldmljZVR5cGUgJiYgIWlkTWF0Y2gpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzUsXG4gICAgICAgICdkZXZpY2VUeXBlIG11c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJyk7XG4gICAgfVxuXG4gIH0pLnRoZW4oKCkgPT4ge1xuICAgIGlmICghaWRNYXRjaCkge1xuICAgICAgaWYgKCFkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH0gZWxzZSBpZiAoZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmXG4gICAgICAgICghZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydpbnN0YWxsYXRpb25JZCddIHx8ICFpbnN0YWxsYXRpb25JZClcbiAgICAgICkge1xuICAgICAgICAvLyBTaW5nbGUgbWF0Y2ggb24gZGV2aWNlIHRva2VuIGJ1dCBub25lIG9uIGluc3RhbGxhdGlvbklkLCBhbmQgZWl0aGVyXG4gICAgICAgIC8vIHRoZSBwYXNzZWQgb2JqZWN0IG9yIHRoZSBtYXRjaCBpcyBtaXNzaW5nIGFuIGluc3RhbGxhdGlvbklkLCBzbyB3ZVxuICAgICAgICAvLyBjYW4ganVzdCByZXR1cm4gdGhlIG1hdGNoLlxuICAgICAgICByZXR1cm4gZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydvYmplY3RJZCddO1xuICAgICAgfSBlbHNlIGlmICghdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzIsXG4gICAgICAgICAgJ011c3Qgc3BlY2lmeSBpbnN0YWxsYXRpb25JZCB3aGVuIGRldmljZVRva2VuICcgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ21hdGNoZXMgbXVsdGlwbGUgSW5zdGFsbGF0aW9uIG9iamVjdHMnKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIE11bHRpcGxlIGRldmljZSB0b2tlbiBtYXRjaGVzIGFuZCB3ZSBzcGVjaWZpZWQgYW4gaW5zdGFsbGF0aW9uIElELFxuICAgICAgICAvLyBvciBhIHNpbmdsZSBtYXRjaCB3aGVyZSBib3RoIHRoZSBwYXNzZWQgYW5kIG1hdGNoaW5nIG9iamVjdHMgaGF2ZVxuICAgICAgICAvLyBhbiBpbnN0YWxsYXRpb24gSUQuIFRyeSBjbGVhbmluZyBvdXQgb2xkIGluc3RhbGxhdGlvbnMgdGhhdCBtYXRjaFxuICAgICAgICAvLyB0aGUgZGV2aWNlVG9rZW4sIGFuZCByZXR1cm4gbmlsIHRvIHNpZ25hbCB0aGF0IGEgbmV3IG9iamVjdCBzaG91bGRcbiAgICAgICAgLy8gYmUgY3JlYXRlZC5cbiAgICAgICAgdmFyIGRlbFF1ZXJ5ID0ge1xuICAgICAgICAgICdkZXZpY2VUb2tlbic6IHRoaXMuZGF0YS5kZXZpY2VUb2tlbixcbiAgICAgICAgICAnaW5zdGFsbGF0aW9uSWQnOiB7XG4gICAgICAgICAgICAnJG5lJzogaW5zdGFsbGF0aW9uSWRcbiAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIGlmICh0aGlzLmRhdGEuYXBwSWRlbnRpZmllcikge1xuICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmNvbmZpZy5kYXRhYmFzZS5kZXN0cm95KCdfSW5zdGFsbGF0aW9uJywgZGVsUXVlcnkpXG4gICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyLmNvZGUgPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgICAgICAvLyBubyBkZWxldGlvbnMgd2VyZSBtYWRlLiBDYW4gYmUgaWdub3JlZC5cbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gcmV0aHJvdyB0aGUgZXJyb3JcbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmXG4gICAgICAgICFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ10pIHtcbiAgICAgICAgLy8gRXhhY3RseSBvbmUgZGV2aWNlIHRva2VuIG1hdGNoIGFuZCBpdCBkb2Vzbid0IGhhdmUgYW4gaW5zdGFsbGF0aW9uXG4gICAgICAgIC8vIElELiBUaGlzIGlzIHRoZSBvbmUgY2FzZSB3aGVyZSB3ZSB3YW50IHRvIG1lcmdlIHdpdGggdGhlIGV4aXN0aW5nXG4gICAgICAgIC8vIG9iamVjdC5cbiAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7b2JqZWN0SWQ6IGlkTWF0Y2gub2JqZWN0SWR9O1xuICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KVxuICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuY2F0Y2goZXJyID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkXG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIHJldGhyb3cgdGhlIGVycm9yXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgICAgICAgaWRNYXRjaC5kZXZpY2VUb2tlbiAhPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICAgICAgICAvLyBXZSdyZSBzZXR0aW5nIHRoZSBkZXZpY2UgdG9rZW4gb24gYW4gZXhpc3RpbmcgaW5zdGFsbGF0aW9uLCBzb1xuICAgICAgICAgIC8vIHdlIHNob3VsZCB0cnkgY2xlYW5pbmcgb3V0IG9sZCBpbnN0YWxsYXRpb25zIHRoYXQgbWF0Y2ggdGhpc1xuICAgICAgICAgIC8vIGRldmljZSB0b2tlbi5cbiAgICAgICAgICBjb25zdCBkZWxRdWVyeSA9IHtcbiAgICAgICAgICAgICdkZXZpY2VUb2tlbic6IHRoaXMuZGF0YS5kZXZpY2VUb2tlbixcbiAgICAgICAgICB9O1xuICAgICAgICAgIC8vIFdlIGhhdmUgYSB1bmlxdWUgaW5zdGFsbCBJZCwgdXNlIHRoYXQgdG8gcHJlc2VydmVcbiAgICAgICAgICAvLyB0aGUgaW50ZXJlc3RpbmcgaW5zdGFsbGF0aW9uXG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgICAgZGVsUXVlcnlbJ2luc3RhbGxhdGlvbklkJ10gPSB7XG4gICAgICAgICAgICAgICckbmUnOiB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWRcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKGlkTWF0Y2gub2JqZWN0SWQgJiYgdGhpcy5kYXRhLm9iamVjdElkXG4gICAgICAgICAgICAgICAgICAgICYmIGlkTWF0Y2gub2JqZWN0SWQgPT0gdGhpcy5kYXRhLm9iamVjdElkKSB7XG4gICAgICAgICAgICAvLyB3ZSBwYXNzZWQgYW4gb2JqZWN0SWQsIHByZXNlcnZlIHRoYXQgaW5zdGFsYXRpb25cbiAgICAgICAgICAgIGRlbFF1ZXJ5WydvYmplY3RJZCddID0ge1xuICAgICAgICAgICAgICAnJG5lJzogaWRNYXRjaC5vYmplY3RJZFxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBXaGF0IHRvIGRvIGhlcmU/IGNhbid0IHJlYWxseSBjbGVhbiB1cCBldmVyeXRoaW5nLi4uXG4gICAgICAgICAgICByZXR1cm4gaWRNYXRjaC5vYmplY3RJZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyKSB7XG4gICAgICAgICAgICBkZWxRdWVyeVsnYXBwSWRlbnRpZmllciddID0gdGhpcy5kYXRhLmFwcElkZW50aWZpZXI7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koJ19JbnN0YWxsYXRpb24nLCBkZWxRdWVyeSlcbiAgICAgICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgICBpZiAoZXJyLmNvZGUgPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkLlxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAvLyByZXRocm93IHRoZSBlcnJvclxuICAgICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICAvLyBJbiBub24tbWVyZ2Ugc2NlbmFyaW9zLCBqdXN0IHJldHVybiB0aGUgaW5zdGFsbGF0aW9uIG1hdGNoIGlkXG4gICAgICAgIHJldHVybiBpZE1hdGNoLm9iamVjdElkO1xuICAgICAgfVxuICAgIH1cbiAgfSkudGhlbigob2JqSWQpID0+IHtcbiAgICBpZiAob2JqSWQpIHtcbiAgICAgIHRoaXMucXVlcnkgPSB7b2JqZWN0SWQ6IG9iaklkfTtcbiAgICAgIGRlbGV0ZSB0aGlzLmRhdGEub2JqZWN0SWQ7XG4gICAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcbiAgICB9XG4gICAgLy8gVE9ETzogVmFsaWRhdGUgb3BzIChhZGQvcmVtb3ZlIG9uIGNoYW5uZWxzLCAkaW5jIG9uIGJhZGdlLCBldGMuKVxuICB9KTtcbiAgcmV0dXJuIHByb21pc2U7XG59O1xuXG4vLyBJZiB3ZSBzaG9ydC1jaXJjdXRlZCB0aGUgb2JqZWN0IHJlc3BvbnNlIC0gdGhlbiB3ZSBuZWVkIHRvIG1ha2Ugc3VyZSB3ZSBleHBhbmQgYWxsIHRoZSBmaWxlcyxcbi8vIHNpbmNlIHRoaXMgbWlnaHQgbm90IGhhdmUgYSBxdWVyeSwgbWVhbmluZyBpdCB3b24ndCByZXR1cm4gdGhlIGZ1bGwgcmVzdWx0IGJhY2suXG4vLyBUT0RPOiAobmx1dHNlbmtvKSBUaGlzIHNob3VsZCBkaWUgd2hlbiB3ZSBtb3ZlIHRvIHBlci1jbGFzcyBiYXNlZCBjb250cm9sbGVycyBvbiBfU2Vzc2lvbi9fVXNlclxuUmVzdFdyaXRlLnByb3RvdHlwZS5leHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyA9IGZ1bmN0aW9uKCkge1xuICAvLyBDaGVjayB3aGV0aGVyIHdlIGhhdmUgYSBzaG9ydC1jaXJjdWl0ZWQgcmVzcG9uc2UgLSBvbmx5IHRoZW4gcnVuIGV4cGFuc2lvbi5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHRoaXMuY29uZmlnLCB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5EYXRhYmFzZU9wZXJhdGlvbiA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Sb2xlJykge1xuICAgIHRoaXMuY29uZmlnLmNhY2hlQ29udHJvbGxlci5yb2xlLmNsZWFyKCk7XG4gIH1cblxuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMucXVlcnkgJiZcbiAgICAgIHRoaXMuYXV0aC5pc1VuYXV0aGVudGljYXRlZCgpKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNFU1NJT05fTUlTU0lORywgYENhbm5vdCBtb2RpZnkgdXNlciAke3RoaXMucXVlcnkub2JqZWN0SWR9LmApO1xuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1Byb2R1Y3QnICYmIHRoaXMuZGF0YS5kb3dubG9hZCkge1xuICAgIHRoaXMuZGF0YS5kb3dubG9hZE5hbWUgPSB0aGlzLmRhdGEuZG93bmxvYWQubmFtZTtcbiAgfVxuXG4gIC8vIFRPRE86IEFkZCBiZXR0ZXIgZGV0ZWN0aW9uIGZvciBBQ0wsIGVuc3VyaW5nIGEgdXNlciBjYW4ndCBiZSBsb2NrZWQgZnJvbVxuICAvLyAgICAgICB0aGVpciBvd24gdXNlciByZWNvcmQuXG4gIGlmICh0aGlzLmRhdGEuQUNMICYmIHRoaXMuZGF0YS5BQ0xbJyp1bnJlc29sdmVkJ10pIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9BQ0wsICdJbnZhbGlkIEFDTC4nKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgLy8gRm9yY2UgdGhlIHVzZXIgdG8gbm90IGxvY2tvdXRcbiAgICAvLyBNYXRjaGVkIHdpdGggcGFyc2UuY29tXG4gICAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmIHRoaXMuZGF0YS5BQ0wgJiYgdGhpcy5hdXRoLmlzTWFzdGVyICE9PSB0cnVlKSB7XG4gICAgICB0aGlzLmRhdGEuQUNMW3RoaXMucXVlcnkub2JqZWN0SWRdID0geyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9O1xuICAgIH1cbiAgICAvLyB1cGRhdGUgcGFzc3dvcmQgdGltZXN0YW1wIGlmIHVzZXIgcGFzc3dvcmQgaXMgYmVpbmcgY2hhbmdlZFxuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJiB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZSkge1xuICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICB9XG4gICAgLy8gSWdub3JlIGNyZWF0ZWRBdCB3aGVuIHVwZGF0ZVxuICAgIGRlbGV0ZSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgbGV0IGRlZmVyID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgLy8gaWYgcGFzc3dvcmQgaGlzdG9yeSBpcyBlbmFibGVkIHRoZW4gc2F2ZSB0aGUgY3VycmVudCBwYXNzd29yZCB0byBoaXN0b3J5XG4gICAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSkge1xuICAgICAgZGVmZXIgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKCdfVXNlcicsIHtvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpfSwge2tleXM6IFtcIl9wYXNzd29yZF9oaXN0b3J5XCIsIFwiX2hhc2hlZF9wYXNzd29yZFwiXX0pLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICBsZXQgb2xkUGFzc3dvcmRzID0gW107XG4gICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KSB7XG4gICAgICAgICAgb2xkUGFzc3dvcmRzID0gXy50YWtlKHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSk7XG4gICAgICAgIH1cbiAgICAgICAgLy9uLTEgcGFzc3dvcmRzIGdvIGludG8gaGlzdG9yeSBpbmNsdWRpbmcgbGFzdCBwYXNzd29yZFxuICAgICAgICB3aGlsZSAob2xkUGFzc3dvcmRzLmxlbmd0aCA+IHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDIpIHtcbiAgICAgICAgICBvbGRQYXNzd29yZHMuc2hpZnQoKTtcbiAgICAgICAgfVxuICAgICAgICBvbGRQYXNzd29yZHMucHVzaCh1c2VyLnBhc3N3b3JkKTtcbiAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9oaXN0b3J5ID0gb2xkUGFzc3dvcmRzO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRlZmVyLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gUnVuIGFuIHVwZGF0ZVxuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZSh0aGlzLmNsYXNzTmFtZSwgdGhpcy5xdWVyeSwgdGhpcy5kYXRhLCB0aGlzLnJ1bk9wdGlvbnMpXG4gICAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICByZXNwb25zZS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICAgICAgICB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKHJlc3BvbnNlLCB0aGlzLmRhdGEpO1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UgPSB7IHJlc3BvbnNlIH07XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIC8vIFNldCB0aGUgZGVmYXVsdCBBQ0wgYW5kIHBhc3N3b3JkIHRpbWVzdGFtcCBmb3IgdGhlIG5ldyBfVXNlclxuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgICAgdmFyIEFDTCA9IHRoaXMuZGF0YS5BQ0w7XG4gICAgICAvLyBkZWZhdWx0IHB1YmxpYyByL3cgQUNMXG4gICAgICBpZiAoIUFDTCkge1xuICAgICAgICBBQ0wgPSB7fTtcbiAgICAgICAgQUNMWycqJ10gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiBmYWxzZSB9O1xuICAgICAgfVxuICAgICAgLy8gbWFrZSBzdXJlIHRoZSB1c2VyIGlzIG5vdCBsb2NrZWQgZG93blxuICAgICAgQUNMW3RoaXMuZGF0YS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgICB0aGlzLmRhdGEuQUNMID0gQUNMO1xuICAgICAgLy8gcGFzc3dvcmQgdGltZXN0YW1wIHRvIGJlIHVzZWQgd2hlbiBwYXNzd29yZCBleHBpcnkgcG9saWN5IGlzIGVuZm9yY2VkXG4gICAgICBpZiAodGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiYgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UpIHtcbiAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSdW4gYSBjcmVhdGVcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuY3JlYXRlKHRoaXMuY2xhc3NOYW1lLCB0aGlzLmRhdGEsIHRoaXMucnVuT3B0aW9ucylcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCBlcnJvci5jb2RlICE9PSBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUpIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFF1aWNrIGNoZWNrLCBpZiB3ZSB3ZXJlIGFibGUgdG8gaW5mZXIgdGhlIGR1cGxpY2F0ZWQgZmllbGQgbmFtZVxuICAgICAgICBpZiAoZXJyb3IgJiYgZXJyb3IudXNlckluZm8gJiYgZXJyb3IudXNlckluZm8uZHVwbGljYXRlZF9maWVsZCA9PT0gJ3VzZXJuYW1lJykge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTiwgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZXJyb3IgJiYgZXJyb3IudXNlckluZm8gJiYgZXJyb3IudXNlckluZm8uZHVwbGljYXRlZF9maWVsZCA9PT0gJ2VtYWlsJykge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5FTUFJTF9UQUtFTiwgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIElmIHRoaXMgd2FzIGEgZmFpbGVkIHVzZXIgY3JlYXRpb24gZHVlIHRvIHVzZXJuYW1lIG9yIGVtYWlsIGFscmVhZHkgdGFrZW4sIHdlIG5lZWQgdG9cbiAgICAgICAgLy8gY2hlY2sgd2hldGhlciBpdCB3YXMgdXNlcm5hbWUgb3IgZW1haWwgYW5kIHJldHVybiB0aGUgYXBwcm9wcmlhdGUgZXJyb3IuXG4gICAgICAgIC8vIEZhbGxiYWNrIHRvIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICAgICAgLy8gVE9ETzogU2VlIGlmIHdlIGNhbiBsYXRlciBkbyB0aGlzIHdpdGhvdXQgYWRkaXRpb25hbCBxdWVyaWVzIGJ5IHVzaW5nIG5hbWVkIGluZGV4ZXMuXG4gICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHsgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSwgb2JqZWN0SWQ6IHsnJG5lJzogdGhpcy5vYmplY3RJZCgpfSB9LFxuICAgICAgICAgIHsgbGltaXQ6IDEgfVxuICAgICAgICApXG4gICAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTiwgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICAgIHsgZW1haWw6IHRoaXMuZGF0YS5lbWFpbCwgb2JqZWN0SWQ6IHsnJG5lJzogdGhpcy5vYmplY3RJZCgpfSB9LFxuICAgICAgICAgICAgICB7IGxpbWl0OiAxIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLCAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSwgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnKTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgIHJlc3BvbnNlLm9iamVjdElkID0gdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICByZXNwb25zZS5jcmVhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgICAgIGlmICh0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lKSB7XG4gICAgICAgICAgcmVzcG9uc2UudXNlcm5hbWUgPSB0aGlzLmRhdGEudXNlcm5hbWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShyZXNwb25zZSwgdGhpcy5kYXRhKTtcbiAgICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgICBzdGF0dXM6IDIwMSxcbiAgICAgICAgICByZXNwb25zZSxcbiAgICAgICAgICBsb2NhdGlvbjogdGhpcy5sb2NhdGlvbigpXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgfVxufTtcblxuLy8gUmV0dXJucyBub3RoaW5nIC0gZG9lc24ndCB3YWl0IGZvciB0aGUgdHJpZ2dlci5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQWZ0ZXJUcmlnZ2VyID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5yZXNwb25zZSB8fCAhdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyU2F2ZScgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJTYXZlSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHModGhpcy5jbGFzc05hbWUsIHRyaWdnZXJzLlR5cGVzLmFmdGVyU2F2ZSwgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGNvbnN0IGhhc0xpdmVRdWVyeSA9IHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIuaGFzTGl2ZVF1ZXJ5KHRoaXMuY2xhc3NOYW1lKTtcbiAgaWYgKCFoYXNBZnRlclNhdmVIb29rICYmICFoYXNMaXZlUXVlcnkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB2YXIgZXh0cmFEYXRhID0ge2NsYXNzTmFtZTogdGhpcy5jbGFzc05hbWV9O1xuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgZXh0cmFEYXRhLm9iamVjdElkID0gdGhpcy5xdWVyeS5vYmplY3RJZDtcbiAgfVxuXG4gIC8vIEJ1aWxkIHRoZSBvcmlnaW5hbCBvYmplY3QsIHdlIG9ubHkgZG8gdGhpcyBmb3IgYSB1cGRhdGUgd3JpdGUuXG4gIGxldCBvcmlnaW5hbE9iamVjdDtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIG9yaWdpbmFsT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgfVxuXG4gIC8vIEJ1aWxkIHRoZSBpbmZsYXRlZCBvYmplY3QsIGRpZmZlcmVudCBmcm9tIGJlZm9yZVNhdmUsIG9yaWdpbmFsRGF0YSBpcyBub3QgZW1wdHlcbiAgLy8gc2luY2UgZGV2ZWxvcGVycyBjYW4gY2hhbmdlIGRhdGEgaW4gdGhlIGJlZm9yZVNhdmUuXG4gIGNvbnN0IHVwZGF0ZWRPYmplY3QgPSB0aGlzLmJ1aWxkVXBkYXRlZE9iamVjdChleHRyYURhdGEpO1xuICB1cGRhdGVkT2JqZWN0Ll9oYW5kbGVTYXZlUmVzcG9uc2UodGhpcy5yZXNwb25zZS5yZXNwb25zZSwgdGhpcy5yZXNwb25zZS5zdGF0dXMgfHwgMjAwKTtcblxuICAvLyBOb3RpZml5IExpdmVRdWVyeVNlcnZlciBpZiBwb3NzaWJsZVxuICB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLm9uQWZ0ZXJTYXZlKHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lLCB1cGRhdGVkT2JqZWN0LCBvcmlnaW5hbE9iamVjdCk7XG5cbiAgLy8gUnVuIGFmdGVyU2F2ZSB0cmlnZ2VyXG4gIHJldHVybiB0cmlnZ2Vycy5tYXliZVJ1blRyaWdnZXIodHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLCB0aGlzLmF1dGgsIHVwZGF0ZWRPYmplY3QsIG9yaWdpbmFsT2JqZWN0LCB0aGlzLmNvbmZpZywgdGhpcy5jb250ZXh0KVxuICAgIC5jYXRjaChmdW5jdGlvbihlcnIpIHtcbiAgICAgIGxvZ2dlci53YXJuKCdhZnRlclNhdmUgY2F1Z2h0IGFuIGVycm9yJywgZXJyKTtcbiAgICB9KVxufTtcblxuLy8gQSBoZWxwZXIgdG8gZmlndXJlIG91dCB3aGF0IGxvY2F0aW9uIHRoaXMgb3BlcmF0aW9uIGhhcHBlbnMgYXQuXG5SZXN0V3JpdGUucHJvdG90eXBlLmxvY2F0aW9uID0gZnVuY3Rpb24oKSB7XG4gIHZhciBtaWRkbGUgPSAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgPyAnL3VzZXJzLycgOlxuICAgICcvY2xhc3Nlcy8nICsgdGhpcy5jbGFzc05hbWUgKyAnLycpO1xuICByZXR1cm4gdGhpcy5jb25maWcubW91bnQgKyBtaWRkbGUgKyB0aGlzLmRhdGEub2JqZWN0SWQ7XG59O1xuXG4vLyBBIGhlbHBlciB0byBnZXQgdGhlIG9iamVjdCBpZCBmb3IgdGhpcyBvcGVyYXRpb24uXG4vLyBCZWNhdXNlIGl0IGNvdWxkIGJlIGVpdGhlciBvbiB0aGUgcXVlcnkgb3Igb24gdGhlIGRhdGFcblJlc3RXcml0ZS5wcm90b3R5cGUub2JqZWN0SWQgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuZGF0YS5vYmplY3RJZCB8fCB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xufTtcblxuLy8gUmV0dXJucyBhIGNvcHkgb2YgdGhlIGRhdGEgYW5kIGRlbGV0ZSBiYWQga2V5cyAoX2F1dGhfZGF0YSwgX2hhc2hlZF9wYXNzd29yZC4uLilcblJlc3RXcml0ZS5wcm90b3R5cGUuc2FuaXRpemVkRGF0YSA9IGZ1bmN0aW9uKCkge1xuICBjb25zdCBkYXRhID0gT2JqZWN0LmtleXModGhpcy5kYXRhKS5yZWR1Y2UoKGRhdGEsIGtleSkgPT4ge1xuICAgIC8vIFJlZ2V4cCBjb21lcyBmcm9tIFBhcnNlLk9iamVjdC5wcm90b3R5cGUudmFsaWRhdGVcbiAgICBpZiAoISgvXltBLVphLXpdWzAtOUEtWmEtel9dKiQvKS50ZXN0KGtleSkpIHtcbiAgICAgIGRlbGV0ZSBkYXRhW2tleV07XG4gICAgfVxuICAgIHJldHVybiBkYXRhO1xuICB9LCBkZWVwY29weSh0aGlzLmRhdGEpKTtcbiAgcmV0dXJuIFBhcnNlLl9kZWNvZGUodW5kZWZpbmVkLCBkYXRhKTtcbn1cblxuLy8gUmV0dXJucyBhbiB1cGRhdGVkIGNvcHkgb2YgdGhlIG9iamVjdFxuUmVzdFdyaXRlLnByb3RvdHlwZS5idWlsZFVwZGF0ZWRPYmplY3QgPSBmdW5jdGlvbiAoZXh0cmFEYXRhKSB7XG4gIGNvbnN0IHVwZGF0ZWRPYmplY3QgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdGhpcy5vcmlnaW5hbERhdGEpO1xuICBPYmplY3Qua2V5cyh0aGlzLmRhdGEpLnJlZHVjZShmdW5jdGlvbiAoZGF0YSwga2V5KSB7XG4gICAgaWYgKGtleS5pbmRleE9mKFwiLlwiKSA+IDApIHtcbiAgICAgIC8vIHN1YmRvY3VtZW50IGtleSB3aXRoIGRvdCBub3RhdGlvbiAoJ3gueSc6diA9PiAneCc6eyd5Jzp2fSlcbiAgICAgIGNvbnN0IHNwbGl0dGVkS2V5ID0ga2V5LnNwbGl0KFwiLlwiKTtcbiAgICAgIGNvbnN0IHBhcmVudFByb3AgPSBzcGxpdHRlZEtleVswXTtcbiAgICAgIGxldCBwYXJlbnRWYWwgPSB1cGRhdGVkT2JqZWN0LmdldChwYXJlbnRQcm9wKTtcbiAgICAgIGlmKHR5cGVvZiBwYXJlbnRWYWwgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHBhcmVudFZhbCA9IHt9O1xuICAgICAgfVxuICAgICAgcGFyZW50VmFsW3NwbGl0dGVkS2V5WzFdXSA9IGRhdGFba2V5XTtcbiAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KHBhcmVudFByb3AsIHBhcmVudFZhbCk7XG4gICAgICBkZWxldGUgZGF0YVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfSwgZGVlcGNvcHkodGhpcy5kYXRhKSk7XG5cbiAgdXBkYXRlZE9iamVjdC5zZXQodGhpcy5zYW5pdGl6ZWREYXRhKCkpO1xuICByZXR1cm4gdXBkYXRlZE9iamVjdDtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY2xlYW5Vc2VyQXV0aERhdGEgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSAmJiB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIGNvbnN0IHVzZXIgPSB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlO1xuICAgIGlmICh1c2VyLmF1dGhEYXRhKSB7XG4gICAgICBPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5mb3JFYWNoKChwcm92aWRlcikgPT4ge1xuICAgICAgICBpZiAodXNlci5hdXRoRGF0YVtwcm92aWRlcl0gPT09IG51bGwpIHtcbiAgICAgICAgICBkZWxldGUgdXNlci5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgaWYgKE9iamVjdC5rZXlzKHVzZXIuYXV0aERhdGEpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSA9IGZ1bmN0aW9uKHJlc3BvbnNlLCBkYXRhKSB7XG4gIGlmIChfLmlzRW1wdHkodGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9XG4gIGNvbnN0IGNsaWVudFN1cHBvcnRzRGVsZXRlID0gQ2xpZW50U0RLLnN1cHBvcnRzRm9yd2FyZERlbGV0ZSh0aGlzLmNsaWVudFNESyk7XG4gIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICBjb25zdCBkYXRhVmFsdWUgPSBkYXRhW2ZpZWxkTmFtZV07XG5cbiAgICBpZighcmVzcG9uc2UuaGFzT3duUHJvcGVydHkoZmllbGROYW1lKSkge1xuICAgICAgcmVzcG9uc2VbZmllbGROYW1lXSA9IGRhdGFWYWx1ZTtcbiAgICB9XG5cbiAgICAvLyBTdHJpcHMgb3BlcmF0aW9ucyBmcm9tIHJlc3BvbnNlc1xuICAgIGlmIChyZXNwb25zZVtmaWVsZE5hbWVdICYmIHJlc3BvbnNlW2ZpZWxkTmFtZV0uX19vcCkge1xuICAgICAgZGVsZXRlIHJlc3BvbnNlW2ZpZWxkTmFtZV07XG4gICAgICBpZiAoY2xpZW50U3VwcG9ydHNEZWxldGUgJiYgZGF0YVZhbHVlLl9fb3AgPT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgcmVzcG9uc2VbZmllbGROYW1lXSA9IGRhdGFWYWx1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gcmVzcG9uc2U7XG59XG5cbmV4cG9ydCBkZWZhdWx0IFJlc3RXcml0ZTtcbm1vZHVsZS5leHBvcnRzID0gUmVzdFdyaXRlO1xuIl19