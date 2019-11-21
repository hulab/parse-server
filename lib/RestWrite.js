"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _RestQuery = _interopRequireDefault(require("./RestQuery"));

var _lodash = _interopRequireDefault(require("lodash"));

var _logger = _interopRequireDefault(require("./logger"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// A RestWrite encapsulates everything we need to run an operation
// that writes to the database.
// This could be either a "create" or an "update".
const AWSXRay = require('hulab-xray-sdk');

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

  if (!query && data.id) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'id is an invalid field name.');
  } // When the operation is complete, this.response may have several
  // fields.
  // response: the actual data to be returned
  // status: the http status code. if not present, treated like a 200
  // location: the location header. if not present, no location header


  this.response = null; // Processing this operation may mutate our data, so we operate on a
  // copy

  this.query = deepcopy(query);
  this.data = deepcopy(data); // We never change originalData, so we do not need a deep copy

  this.originalData = originalData; // The timestamp we'll use for this whole operation

  this.updatedAt = Parse._encode(new Date()).iso; // Shared SchemaController to be reused to reduce the number of loadSchema() calls per request
  // Once set the schemaData should be immutable

  this.validSchemaController = null;
} // A convenient method to perform all the steps of processing the
// write, in order.
// Returns a promise for a {response, status, location} object.
// status and location are optional.


RestWrite.prototype.execute = function () {
  return Promise.resolve().then(() => {
    return tracePromise('getUserAndRoleACL', this.className, this.getUserAndRoleACL());
  }).then(() => {
    return tracePromise('validateClientClassCreation', this.className, this.validateClientClassCreation());
  }).then(() => {
    return tracePromise('handleInstallation', this.className, this.handleInstallation());
  }).then(() => {
    return tracePromise('handleSession', this.className, this.handleSession());
  }).then(() => {
    return tracePromise('validateAuthData', this.className, this.validateAuthData());
  }).then(() => {
    return tracePromise('runBeforeSaveTrigger', this.className, this.runBeforeSaveTrigger());
  }).then(() => {
    return tracePromise('deleteEmailResetTokenIfNeeded', this.className, this.deleteEmailResetTokenIfNeeded());
  }).then(() => {
    return tracePromise('validateSchema', this.className, this.validateSchema());
  }).then(schemaController => {
    this.validSchemaController = schemaController;
    return tracePromise('setRequiredFieldsIfNeeded', this.className, this.setRequiredFieldsIfNeeded());
  }).then(() => {
    return tracePromise('transformUser', this.className, this.transformUser());
  }).then(() => {
    return tracePromise('expandFilesForExistingObjects', this.className, this.expandFilesForExistingObjects());
  }).then(() => {
    return tracePromise('destroyDuplicatedSessions', this.className, this.destroyDuplicatedSessions());
  }).then(() => {
    return tracePromise('runDatabaseOperation', this.className, this.runDatabaseOperation());
  }).then(() => {
    return tracePromise('createSessionTokenIfNeeded', this.className, this.createSessionTokenIfNeeded());
  }).then(() => {
    return tracePromise('handleFollowup', this.className, this.handleFollowup());
  }).then(() => {
    return tracePromise('runAfterSaveTrigger', this.className, this.runAfterSaveTrigger());
  }).then(() => {
    return tracePromise('cleanUserAuthData', this.className, this.cleanUserAuthData());
  }).then(() => {
    return this.response;
  });
}; // Uses the Auth object to get the list of roles, adds the user id


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
}; // Validates this operation against the allowClientClassCreation config.


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
}; // Validates this operation against the schema.


RestWrite.prototype.validateSchema = function () {
  return this.config.database.validateObject(this.className, this.data, this.query, this.runOptions);
}; // Runs any beforeSave triggers against this operation.
// Any change leads to our data being mutated.


RestWrite.prototype.runBeforeSaveTrigger = function () {
  if (this.response) {
    return;
  } // Avoid doing any setup for triggers if there is no 'beforeSave' trigger for this class.


  if (!triggers.triggerExists(this.className, triggers.Types.beforeSave, this.config.applicationId)) {
    return Promise.resolve();
  } // Cloud code gets a bit of extra data for its objects


  var extraData = {
    className: this.className
  };

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
    // Before calling the trigger, validate the permissions for the save operation
    let databasePromise = null;

    if (this.query) {
      // Validate for updating
      databasePromise = this.config.database.update(this.className, this.query, this.data, this.runOptions, false, true);
    } else {
      // Validate for creating
      databasePromise = this.config.database.create(this.className, this.data, this.runOptions, true);
    } // In the case that there is no permission for the operation, it throws an error


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
      this.data = response.object; // We should delete the objectId for an update write

      if (this.query && this.query.objectId) {
        delete this.data.objectId;
      }
    }
  });
};

RestWrite.prototype.runBeforeLoginTrigger = async function (userData) {
  // Avoid doing any setup for triggers if there is no 'beforeLogin' trigger
  if (!triggers.triggerExists(this.className, triggers.Types.beforeLogin, this.config.applicationId)) {
    return;
  } // Cloud code gets a bit of extra data for its objects


  const extraData = {
    className: this.className
  };
  const user = triggers.inflate(extraData, userData); // no need to return a response

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
      }; // Add default fields


      this.data.updatedAt = this.updatedAt;

      if (!this.query) {
        this.data.createdAt = this.updatedAt; // Only assign new objectId if we are creating new object

        if (!this.data.objectId) {
          this.data.objectId = cryptoUtils.newObjectId(this.config.objectIdSize);
        }

        if (schema) {
          Object.keys(schema.fields).forEach(fieldName => {
            setRequiredFieldIfNeeded(fieldName, true);
          });
        }
      } else if (schema) {
        Object.keys(this.data).forEach(fieldName => {
          setRequiredFieldIfNeeded(fieldName, false);
        });
      }
    });
  }

  return Promise.resolve();
}; // Transforms auth data for a user object.
// Does nothing if this isn't a user object.
// Returns a promise for when we're done if it can't finish this tick.


RestWrite.prototype.validateAuthData = function () {
  if (this.className !== '_User') {
    return;
  }

  if (!this.query && !this.data.authData) {
    if (typeof this.data.username !== 'string' || _lodash.default.isEmpty(this.data.username)) {
      throw new Parse.Error(Parse.Error.USERNAME_MISSING, 'bad or missing username');
    }

    if (typeof this.data.password !== 'string' || _lodash.default.isEmpty(this.data.password)) {
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
    findPromise = this.config.database.find(this.className, {
      $or: query
    }, {});
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
    } // Regular users that have been locked out.


    return object.ACL && Object.keys(object.ACL).length > 0;
  });
};

RestWrite.prototype.handleAuthData = function (authData) {
  let results;
  return this.findUsersWithAuthData(authData).then(async r => {
    results = this.filteredObjectsByACL(r);

    if (results.length == 1) {
      this.storage['authProvider'] = Object.keys(authData).join(',');
      const userResult = results[0];
      const mutatedAuthData = {};
      Object.keys(authData).forEach(provider => {
        const providerData = authData[provider];
        const userAuthData = userResult.authData[provider];

        const equalAuthData = this.config.authDataManager.getEqualityForProvider(provider) || _lodash.default.isEqual;

        if (!equalAuthData(providerData, userAuthData)) {
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
        delete results[0].password; // need to set the objectId first otherwise location has trailing undefined

        this.data.objectId = userResult.objectId;

        if (!this.query || !this.query.objectId) {
          // this a login call, no userId passed
          this.response = {
            response: userResult,
            location: this.location()
          }; // Run beforeLogin hook before storing any updates
          // to authData on the db; changes to userResult
          // will be ignored.

          await this.runBeforeLoginTrigger(deepcopy(userResult));
        } // If we didn't change the auth data, just keep going


        if (!hasMutatedAuthData) {
          return;
        } // We have authData that is updated on login
        // that can happen when token are refreshed,
        // We should update the token and let the user in
        // We should only check the mutated keys


        return this.handleAuthDataValidation(mutatedAuthData).then(async () => {
          // IF we have a response, we'll skip the database operation / beforeSave / afterSave etc...
          // we need to set it up there.
          // We are supposed to have a response only on LOGIN with authData, so we skip those
          // If we're not logging in, but just updating the current user, we can safely skip that part
          if (this.response) {
            // Assign the new authData in the response
            Object.keys(mutatedAuthData).forEach(provider => {
              this.response.response.authData[provider] = mutatedAuthData[provider];
            }); // Run the DB update directly, as 'master'
            // Just update the authData part
            // Then we're good for the user, early exit of sorts

            return this.config.database.update(this.className, {
              objectId: this.data.objectId
            }, {
              authData: mutatedAuthData
            }, {});
          }
        });
      } else if (userId) {
        // Trying to update auth data but users
        // are different
        if (userResult.objectId !== userId) {
          throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
        } // No auth data was mutated, just keep going


        if (!hasMutatedAuthData) {
          return;
        }
      }
    }

    return this.handleAuthDataValidation(authData).then(() => {
      if (results.length > 1) {
        // More than 1 user with the passed id's
        throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
      }
    });
  });
}; // The non-third-party parts of User transformation


RestWrite.prototype.transformUser = function () {
  var promise = Promise.resolve();

  if (this.className !== '_User') {
    return promise;
  }

  if (!this.auth.isMaster && 'emailVerified' in this.data) {
    const error = `Clients aren't allowed to manually update email verification.`;
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, error);
  } // Do not cleanup session if objectId is not set


  if (this.query && this.objectId()) {
    // If we're updating a _User object, we need to clear out the cache for that user. Find all their
    // session tokens, and remove them from the cache.
    promise = new _RestQuery.default(this.config, Auth.master(this.config), '_Session', {
      user: {
        __type: 'Pointer',
        className: '_User',
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
      this.storage['clearSessions'] = true; // Generate a new session only if the user requested

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
  } // We need to a find to check for duplicate username in case they are missing the unique index on usernames
  // TODO: Check if there is a unique index, and if so, skip this query.


  return this.config.database.find(this.className, {
    username: this.data.username,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1
  }, {}, this.validSchemaController).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
    }

    return;
  });
};

RestWrite.prototype._validateEmail = function () {
  if (!this.data.email || this.data.email.__op === 'Delete') {
    return Promise.resolve();
  } // Validate basic email address format


  if (!this.data.email.match(/^.+@.+$/)) {
    return Promise.reject(new Parse.Error(Parse.Error.INVALID_EMAIL_ADDRESS, 'Email address format is invalid.'));
  } // Same problem for email as above for username


  return this.config.database.find(this.className, {
    email: this.data.email,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1
  }, {}, this.validSchemaController).then(results => {
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
  // If we specified a custom error in our configuration use it.
  // Example: "Passwords must include a Capital Letter, Lowercase Letter, and a number."
  //
  // This is especially useful on the generic "password reset" page,
  // as it allows the programmer to communicate specific requirements instead of:
  // a. making the user guess whats wrong
  // b. making a custom password reset page that shows the requirements
  const policyError = this.config.passwordPolicy.validationError ? this.config.passwordPolicy.validationError : 'Password does not meet the Password Policy requirements.';
  const containsUsernameError = 'Password cannot contain your username.'; // check whether the password meets the password strength requirements

  if (this.config.passwordPolicy.patternValidator && !this.config.passwordPolicy.patternValidator(this.data.password) || this.config.passwordPolicy.validatorCallback && !this.config.passwordPolicy.validatorCallback(this.data.password)) {
    return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, policyError));
  } // check whether password contain username


  if (this.config.passwordPolicy.doNotAllowUsername === true) {
    if (this.data.username) {
      // username is not passed during password reset
      if (this.data.password.indexOf(this.data.username) >= 0) return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
    } else {
      // retrieve the User object using objectId during password reset
      return this.config.database.find('_User', {
        objectId: this.objectId()
      }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }

        if (this.data.password.indexOf(results[0].username) >= 0) return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
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
    }).then(results => {
      if (results.length != 1) {
        throw undefined;
      }

      const user = results[0];
      let oldPasswords = [];
      if (user._password_history) oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory - 1);
      oldPasswords.push(user.password);
      const newPassword = this.data.password; // compare the new password hash with all old password hashes

      const promises = oldPasswords.map(function (hash) {
        return passwordCrypto.compare(newPassword, hash).then(result => {
          if (result) // reject if there is a match
            return Promise.reject('REPEAT_PASSWORD');
          return Promise.resolve();
        });
      }); // wait for all comparisons to complete

      return Promise.all(promises).then(() => {
        return Promise.resolve();
      }).catch(err => {
        if (err === 'REPEAT_PASSWORD') // a match was found
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
  } // Don't generate session for updating user (this.query is set) unless authData exists


  if (this.query && !this.data.authData) {
    return;
  } // Don't generate new sessionToken if linking via sessionToken


  if (this.auth.user && this.data.authData) {
    return;
  }

  if (!this.storage['authProvider'] && // signup call, with
  this.config.preventLoginWithUnverifiedEmail && // no login without verification
  this.config.verifyUserEmails) {
    // verification is on
    return; // do not create the session token in that case!
  }

  return this.createSessionToken();
};

RestWrite.prototype.createSessionToken = async function () {
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
      action: this.storage['authProvider'] ? 'login' : 'signup',
      authProvider: this.storage['authProvider'] || 'password'
    },
    installationId: this.auth.installationId
  });

  if (this.response && this.response.response) {
    this.response.response.sessionToken = sessionData.sessionToken;
  }

  return createSession();
}; // Delete email reset tokens if user is changing password or email.


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
  } // Destroy the sessions in 'Background'


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
    sessionToken: {
      $ne: sessionToken
    }
  }, {}, this.validSchemaController);
}; // Handles any followup logic


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
    delete this.storage['sendVerificationEmail']; // Fire and forget!

    this.config.userController.sendVerificationEmail(this.data);
    return this.handleFollowup.bind(this);
  }
}; // Handles the _Session class specialness.
// Does nothing if this isn't an _Session object.


RestWrite.prototype.handleSession = function () {
  if (this.response || this.className !== '_Session') {
    return;
  }

  if (!this.auth.user && !this.auth.isMaster) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token required.');
  } // TODO: Verify proper error to throw


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

    const {
      sessionData,
      createSession
    } = Auth.createSession(this.config, {
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
}; // Handles the _Installation class specialness.
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
  } // If the device token is 64 characters long, we assume it is for iOS
  // and lowercase it.


  if (this.data.deviceToken && this.data.deviceToken.length == 64) {
    this.data.deviceToken = this.data.deviceToken.toLowerCase();
  } // We lowercase the installationId if present


  if (this.data.installationId) {
    this.data.installationId = this.data.installationId.toLowerCase();
  }

  let installationId = this.data.installationId; // If data.installationId is not set and we're not master, we can lookup in auth

  if (!installationId && !this.auth.isMaster) {
    installationId = this.auth.installationId;
  }

  if (installationId) {
    installationId = installationId.toLowerCase();
  } // Updating _Installation but not updating anything critical


  if (this.query && !this.data.deviceToken && !installationId && !this.data.deviceType) {
    return;
  }

  var promise = Promise.resolve();
  var idMatch; // Will be a match on either objectId or installationId

  var objectIdMatch;
  var installationIdMatch;
  var deviceTokenMatches = []; // Instead of issuing 3 reads, let's do it with one OR.

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
    }); // Sanity checks when running a query

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
    } // need to specify deviceType only if it's new


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
          deviceToken: this.data.deviceToken,
          installationId: {
            $ne: installationId
          }
        };

        if (this.data.appIdentifier) {
          delQuery['appIdentifier'] = this.data.appIdentifier;
        }

        this.config.database.destroy('_Installation', delQuery).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored.
            return;
          } // rethrow the error


          throw err;
        });
        return;
      }
    } else {
      if (deviceTokenMatches.length == 1 && !deviceTokenMatches[0]['installationId']) {
        // Exactly one device token match and it doesn't have an installation
        // ID. This is the one case where we want to merge with the existing
        // object.
        const delQuery = {
          objectId: idMatch.objectId
        };
        return this.config.database.destroy('_Installation', delQuery).then(() => {
          return deviceTokenMatches[0]['objectId'];
        }).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored
            return;
          } // rethrow the error


          throw err;
        });
      } else {
        if (this.data.deviceToken && idMatch.deviceToken != this.data.deviceToken) {
          // We're setting the device token on an existing installation, so
          // we should try cleaning out old installations that match this
          // device token.
          const delQuery = {
            deviceToken: this.data.deviceToken
          }; // We have a unique install Id, use that to preserve
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

          this.config.database.destroy('_Installation', delQuery).catch(err => {
            if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
              // no deletions were made. Can be ignored.
              return;
            } // rethrow the error


            throw err;
          });
        } // In non-merge scenarios, just return the installation match id


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
    } // TODO: Validate ops (add/remove on channels, $inc on badge, etc.)

  });
  return promise;
}; // If we short-circuted the object response - then we need to make sure we expand all the files,
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
  } // TODO: Add better detection for ACL, ensuring a user can't be locked from
  //       their own user record.


  if (this.data.ACL && this.data.ACL['*unresolved']) {
    throw new Parse.Error(Parse.Error.INVALID_ACL, 'Invalid ACL.');
  }

  if (this.query) {
    // Force the user to not lockout
    // Matched with parse.com
    if (this.className === '_User' && this.data.ACL && this.auth.isMaster !== true) {
      this.data.ACL[this.query.objectId] = {
        read: true,
        write: true
      };
    } // update password timestamp if user password is being changed


    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
      this.data._password_changed_at = Parse._encode(new Date());
    } // Ignore createdAt when update


    delete this.data.createdAt;
    let defer = Promise.resolve(); // if password history is enabled then save the current password to history

    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordHistory) {
      defer = this.config.database.find('_User', {
        objectId: this.objectId()
      }, {
        keys: ['_password_history', '_hashed_password']
      }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }

        const user = results[0];
        let oldPasswords = [];

        if (user._password_history) {
          oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory);
        } //n-1 passwords go into history including last password


        while (oldPasswords.length > Math.max(0, this.config.passwordPolicy.maxPasswordHistory - 2)) {
          oldPasswords.shift();
        }

        oldPasswords.push(user.password);
        this.data._password_history = oldPasswords;
      });
    }

    return defer.then(() => {
      // Run an update
      return this.config.database.update(this.className, this.query, this.data, this.runOptions, false, false, this.validSchemaController).then(response => {
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
      var ACL = this.data.ACL; // default public r/w ACL

      if (!ACL) {
        ACL = {};
        ACL['*'] = {
          read: true,
          write: false
        };
      } // make sure the user is not locked down


      ACL[this.data.objectId] = {
        read: true,
        write: true
      };
      this.data.ACL = ACL; // password timestamp to be used when password expiry policy is enforced

      if (this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
        this.data._password_changed_at = Parse._encode(new Date());
      }
    } // Run a create


    return this.config.database.create(this.className, this.data, this.runOptions, false, this.validSchemaController).catch(error => {
      if (this.className !== '_User' || error.code !== Parse.Error.DUPLICATE_VALUE) {
        throw error;
      } // Quick check, if we were able to infer the duplicated field name


      if (error && error.userInfo && error.userInfo.duplicated_field === 'username') {
        throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
      }

      if (error && error.userInfo && error.userInfo.duplicated_field === 'email') {
        throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
      } // If this was a failed user creation due to username or email already taken, we need to
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
}; // Returns nothing - doesn't wait for the trigger.


RestWrite.prototype.runAfterSaveTrigger = function () {
  if (!this.response || !this.response.response) {
    return;
  } // Avoid doing any setup for triggers if there is no 'afterSave' trigger for this class.


  const hasAfterSaveHook = triggers.triggerExists(this.className, triggers.Types.afterSave, this.config.applicationId);
  const hasLiveQuery = this.config.liveQueryController.hasLiveQuery(this.className);

  if (!hasAfterSaveHook && !hasLiveQuery) {
    return Promise.resolve();
  }

  var extraData = {
    className: this.className
  };

  if (this.query && this.query.objectId) {
    extraData.objectId = this.query.objectId;
  } // Build the original object, we only do this for a update write.


  let originalObject;

  if (this.query && this.query.objectId) {
    originalObject = triggers.inflate(extraData, this.originalData);
  } // Build the inflated object, different from beforeSave, originalData is not empty
  // since developers can change data in the beforeSave.


  const updatedObject = this.buildUpdatedObject(extraData);

  updatedObject._handleSaveResponse(this.response.response, this.response.status || 200);

  this.config.database.loadSchema().then(schemaController => {
    // Notifiy LiveQueryServer if possible
    const perms = schemaController.getClassLevelPermissions(updatedObject.className);
    this.config.liveQueryController.onAfterSave(updatedObject.className, updatedObject, originalObject, perms);
  }); // Run afterSave trigger

  return triggers.maybeRunTrigger(triggers.Types.afterSave, this.auth, updatedObject, originalObject, this.config, this.context).then(result => {
    if (result && typeof result === 'object') {
      this.response.response = result;
    }
  }).catch(function (err) {
    _logger.default.warn('afterSave caught an error', err);
  });
}; // A helper to figure out what location this operation happens at.


RestWrite.prototype.location = function () {
  var middle = this.className === '_User' ? '/users/' : '/classes/' + this.className + '/';
  return this.config.mount + middle + this.data.objectId;
}; // A helper to get the object id for this operation.
// Because it could be either on the query or on the data


RestWrite.prototype.objectId = function () {
  return this.data.objectId || this.query.objectId;
}; // Returns a copy of the data and delete bad keys (_auth_data, _hashed_password...)


RestWrite.prototype.sanitizedData = function () {
  const data = Object.keys(this.data).reduce((data, key) => {
    // Regexp comes from Parse.Object.prototype.validate
    if (!/^[A-Za-z][0-9A-Za-z_]*$/.test(key)) {
      delete data[key];
    }

    return data;
  }, deepcopy(this.data));
  return Parse._decode(undefined, data);
}; // Returns an updated copy of the object


RestWrite.prototype.buildUpdatedObject = function (extraData) {
  const updatedObject = triggers.inflate(extraData, this.originalData);
  Object.keys(this.data).reduce(function (data, key) {
    if (key.indexOf('.') > 0) {
      // subdocument key with dot notation ('x.y':v => 'x':{'y':v})
      const splittedKey = key.split('.');
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
  if (_lodash.default.isEmpty(this.storage.fieldsChangedByTrigger)) {
    return response;
  }

  const clientSupportsDelete = ClientSDK.supportsForwardDelete(this.clientSDK);
  this.storage.fieldsChangedByTrigger.forEach(fieldName => {
    const dataValue = data[fieldName];

    if (!Object.prototype.hasOwnProperty.call(response, fieldName)) {
      response[fieldName] = dataValue;
    } // Strips operations from responses


    if (response[fieldName] && response[fieldName].__op) {
      delete response[fieldName];

      if (clientSupportsDelete && dataValue.__op == 'Delete') {
        response[fieldName] = dataValue;
      }
    }
  });
  return response;
};

function tracePromise(operation, className, promise = Promise.resolve()) {
  const parent = AWSXRay.getSegment();

  if (!parent) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    AWSXRay.captureAsyncFunc(`Parse-Server_RestWrite_${operation}_${className}`, subsegment => {
      subsegment && subsegment.addAnnotation('Controller', 'RestWrite');
      subsegment && subsegment.addAnnotation('Operation', operation);
      className & subsegment && subsegment.addAnnotation('ClassName', className);
      (promise instanceof Promise ? promise : Promise.resolve(promise)).then(function (result) {
        resolve(result);
        subsegment && subsegment.close();
      }, function (error) {
        reject(error);
        subsegment && subsegment.close(error);
      });
    });
  });
}

var _default = RestWrite;
exports.default = _default;
module.exports = RestWrite;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0V3JpdGUuanMiXSwibmFtZXMiOlsiQVdTWFJheSIsInJlcXVpcmUiLCJTY2hlbWFDb250cm9sbGVyIiwiZGVlcGNvcHkiLCJBdXRoIiwiY3J5cHRvVXRpbHMiLCJwYXNzd29yZENyeXB0byIsIlBhcnNlIiwidHJpZ2dlcnMiLCJDbGllbnRTREsiLCJSZXN0V3JpdGUiLCJjb25maWciLCJhdXRoIiwiY2xhc3NOYW1lIiwicXVlcnkiLCJkYXRhIiwib3JpZ2luYWxEYXRhIiwiY2xpZW50U0RLIiwiaXNSZWFkT25seSIsIkVycm9yIiwiT1BFUkFUSU9OX0ZPUkJJRERFTiIsInN0b3JhZ2UiLCJydW5PcHRpb25zIiwiY29udGV4dCIsIm9iamVjdElkIiwiSU5WQUxJRF9LRVlfTkFNRSIsImlkIiwicmVzcG9uc2UiLCJ1cGRhdGVkQXQiLCJfZW5jb2RlIiwiRGF0ZSIsImlzbyIsInZhbGlkU2NoZW1hQ29udHJvbGxlciIsInByb3RvdHlwZSIsImV4ZWN1dGUiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJ0cmFjZVByb21pc2UiLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsImhhbmRsZUluc3RhbGxhdGlvbiIsImhhbmRsZVNlc3Npb24iLCJ2YWxpZGF0ZUF1dGhEYXRhIiwicnVuQmVmb3JlU2F2ZVRyaWdnZXIiLCJkZWxldGVFbWFpbFJlc2V0VG9rZW5JZk5lZWRlZCIsInZhbGlkYXRlU2NoZW1hIiwic2NoZW1hQ29udHJvbGxlciIsInNldFJlcXVpcmVkRmllbGRzSWZOZWVkZWQiLCJ0cmFuc2Zvcm1Vc2VyIiwiZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMiLCJkZXN0cm95RHVwbGljYXRlZFNlc3Npb25zIiwicnVuRGF0YWJhc2VPcGVyYXRpb24iLCJjcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCIsImhhbmRsZUZvbGxvd3VwIiwicnVuQWZ0ZXJTYXZlVHJpZ2dlciIsImNsZWFuVXNlckF1dGhEYXRhIiwiaXNNYXN0ZXIiLCJhY2wiLCJ1c2VyIiwiZ2V0VXNlclJvbGVzIiwicm9sZXMiLCJjb25jYXQiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwiaW5kZXhPZiIsImRhdGFiYXNlIiwibG9hZFNjaGVtYSIsImhhc0NsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJ0cmlnZ2VyRXhpc3RzIiwiVHlwZXMiLCJiZWZvcmVTYXZlIiwiYXBwbGljYXRpb25JZCIsImV4dHJhRGF0YSIsIm9yaWdpbmFsT2JqZWN0IiwidXBkYXRlZE9iamVjdCIsImJ1aWxkVXBkYXRlZE9iamVjdCIsImluZmxhdGUiLCJkYXRhYmFzZVByb21pc2UiLCJ1cGRhdGUiLCJjcmVhdGUiLCJyZXN1bHQiLCJsZW5ndGgiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwibWF5YmVSdW5UcmlnZ2VyIiwib2JqZWN0IiwiZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciIsIl8iLCJyZWR1Y2UiLCJ2YWx1ZSIsImtleSIsImlzRXF1YWwiLCJwdXNoIiwicnVuQmVmb3JlTG9naW5UcmlnZ2VyIiwidXNlckRhdGEiLCJiZWZvcmVMb2dpbiIsImdldEFsbENsYXNzZXMiLCJhbGxDbGFzc2VzIiwic2NoZW1hIiwiZmluZCIsIm9uZUNsYXNzIiwic2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkIiwiZmllbGROYW1lIiwic2V0RGVmYXVsdCIsInVuZGVmaW5lZCIsIl9fb3AiLCJmaWVsZHMiLCJkZWZhdWx0VmFsdWUiLCJyZXF1aXJlZCIsIlZBTElEQVRJT05fRVJST1IiLCJjcmVhdGVkQXQiLCJuZXdPYmplY3RJZCIsIm9iamVjdElkU2l6ZSIsIk9iamVjdCIsImtleXMiLCJmb3JFYWNoIiwiYXV0aERhdGEiLCJ1c2VybmFtZSIsImlzRW1wdHkiLCJVU0VSTkFNRV9NSVNTSU5HIiwicGFzc3dvcmQiLCJQQVNTV09SRF9NSVNTSU5HIiwicHJvdmlkZXJzIiwiY2FuSGFuZGxlQXV0aERhdGEiLCJjYW5IYW5kbGUiLCJwcm92aWRlciIsInByb3ZpZGVyQXV0aERhdGEiLCJoYXNUb2tlbiIsImhhbmRsZUF1dGhEYXRhIiwiVU5TVVBQT1JURURfU0VSVklDRSIsImhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiIsInZhbGlkYXRpb25zIiwibWFwIiwiYXV0aERhdGFNYW5hZ2VyIiwiZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIiLCJhbGwiLCJmaW5kVXNlcnNXaXRoQXV0aERhdGEiLCJtZW1vIiwicXVlcnlLZXkiLCJmaWx0ZXIiLCJxIiwiZmluZFByb21pc2UiLCIkb3IiLCJmaWx0ZXJlZE9iamVjdHNCeUFDTCIsIm9iamVjdHMiLCJBQ0wiLCJyZXN1bHRzIiwiciIsImpvaW4iLCJ1c2VyUmVzdWx0IiwibXV0YXRlZEF1dGhEYXRhIiwicHJvdmlkZXJEYXRhIiwidXNlckF1dGhEYXRhIiwiZXF1YWxBdXRoRGF0YSIsImdldEVxdWFsaXR5Rm9yUHJvdmlkZXIiLCJoYXNNdXRhdGVkQXV0aERhdGEiLCJ1c2VySWQiLCJsb2NhdGlvbiIsIkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQiLCJwcm9taXNlIiwiZXJyb3IiLCJSZXN0UXVlcnkiLCJtYXN0ZXIiLCJfX3R5cGUiLCJzZXNzaW9uIiwiY2FjaGVDb250cm9sbGVyIiwiZGVsIiwic2Vzc2lvblRva2VuIiwiX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kiLCJoYXNoIiwiaGFzaGVkUGFzc3dvcmQiLCJfaGFzaGVkX3Bhc3N3b3JkIiwiX3ZhbGlkYXRlVXNlck5hbWUiLCJfdmFsaWRhdGVFbWFpbCIsInJhbmRvbVN0cmluZyIsInJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lIiwiJG5lIiwibGltaXQiLCJVU0VSTkFNRV9UQUtFTiIsImVtYWlsIiwibWF0Y2giLCJyZWplY3QiLCJJTlZBTElEX0VNQUlMX0FERFJFU1MiLCJFTUFJTF9UQUtFTiIsInVzZXJDb250cm9sbGVyIiwic2V0RW1haWxWZXJpZnlUb2tlbiIsInBhc3N3b3JkUG9saWN5IiwiX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMiLCJfdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkiLCJwb2xpY3lFcnJvciIsInZhbGlkYXRpb25FcnJvciIsImNvbnRhaW5zVXNlcm5hbWVFcnJvciIsInBhdHRlcm5WYWxpZGF0b3IiLCJ2YWxpZGF0b3JDYWxsYmFjayIsImRvTm90QWxsb3dVc2VybmFtZSIsIm1heFBhc3N3b3JkSGlzdG9yeSIsIm9sZFBhc3N3b3JkcyIsIl9wYXNzd29yZF9oaXN0b3J5IiwidGFrZSIsIm5ld1Bhc3N3b3JkIiwicHJvbWlzZXMiLCJjb21wYXJlIiwiY2F0Y2giLCJlcnIiLCJwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsIiwidmVyaWZ5VXNlckVtYWlscyIsImNyZWF0ZVNlc3Npb25Ub2tlbiIsImluc3RhbGxhdGlvbklkIiwic2Vzc2lvbkRhdGEiLCJjcmVhdGVTZXNzaW9uIiwiY3JlYXRlZFdpdGgiLCJhY3Rpb24iLCJhdXRoUHJvdmlkZXIiLCJhZGRPcHMiLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJhc3NpZ24iLCJkZXN0cm95IiwicmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCIsInNlc3Npb25RdWVyeSIsImJpbmQiLCJzZW5kVmVyaWZpY2F0aW9uRW1haWwiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCJhZGRpdGlvbmFsU2Vzc2lvbkRhdGEiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJzdGF0dXMiLCJkZXZpY2VUb2tlbiIsInRvTG93ZXJDYXNlIiwiZGV2aWNlVHlwZSIsImlkTWF0Y2giLCJvYmplY3RJZE1hdGNoIiwiaW5zdGFsbGF0aW9uSWRNYXRjaCIsImRldmljZVRva2VuTWF0Y2hlcyIsIm9yUXVlcmllcyIsImRlbFF1ZXJ5IiwiYXBwSWRlbnRpZmllciIsImNvZGUiLCJvYmpJZCIsImZpbGVzQ29udHJvbGxlciIsImV4cGFuZEZpbGVzSW5PYmplY3QiLCJyb2xlIiwiY2xlYXIiLCJpc1VuYXV0aGVudGljYXRlZCIsIlNFU1NJT05fTUlTU0lORyIsImRvd25sb2FkIiwiZG93bmxvYWROYW1lIiwibmFtZSIsIklOVkFMSURfQUNMIiwicmVhZCIsIndyaXRlIiwibWF4UGFzc3dvcmRBZ2UiLCJfcGFzc3dvcmRfY2hhbmdlZF9hdCIsImRlZmVyIiwiTWF0aCIsIm1heCIsInNoaWZ0IiwiX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEiLCJEVVBMSUNBVEVfVkFMVUUiLCJ1c2VySW5mbyIsImR1cGxpY2F0ZWRfZmllbGQiLCJoYXNBZnRlclNhdmVIb29rIiwiYWZ0ZXJTYXZlIiwiaGFzTGl2ZVF1ZXJ5IiwibGl2ZVF1ZXJ5Q29udHJvbGxlciIsIl9oYW5kbGVTYXZlUmVzcG9uc2UiLCJwZXJtcyIsImdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsIm9uQWZ0ZXJTYXZlIiwibG9nZ2VyIiwid2FybiIsIm1pZGRsZSIsIm1vdW50Iiwic2FuaXRpemVkRGF0YSIsInRlc3QiLCJfZGVjb2RlIiwic3BsaXR0ZWRLZXkiLCJzcGxpdCIsInBhcmVudFByb3AiLCJwYXJlbnRWYWwiLCJnZXQiLCJzZXQiLCJjbGllbnRTdXBwb3J0c0RlbGV0ZSIsInN1cHBvcnRzRm9yd2FyZERlbGV0ZSIsImRhdGFWYWx1ZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIm9wZXJhdGlvbiIsInBhcmVudCIsImdldFNlZ21lbnQiLCJjYXB0dXJlQXN5bmNGdW5jIiwic3Vic2VnbWVudCIsImFkZEFubm90YXRpb24iLCJjbG9zZSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFjQTs7QUFDQTs7QUFDQTs7OztBQWhCQTtBQUNBO0FBQ0E7QUFDQSxNQUFNQSxPQUFPLEdBQUdDLE9BQU8sQ0FBQyxnQkFBRCxDQUF2Qjs7QUFFQSxJQUFJQyxnQkFBZ0IsR0FBR0QsT0FBTyxDQUFDLGdDQUFELENBQTlCOztBQUNBLElBQUlFLFFBQVEsR0FBR0YsT0FBTyxDQUFDLFVBQUQsQ0FBdEI7O0FBRUEsTUFBTUcsSUFBSSxHQUFHSCxPQUFPLENBQUMsUUFB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T0FBbkIsR0FBNkI2SCxPQUE3QixHQUF1QzdILE9BQU8sQ0FBQ0MsT0FBUixDQUFnQjRILE9BQWhCLENBQXhDLEVBQWtFM0gsSUFBbEUsQ0FDRSxVQUFTNkMsTUFBVCxFQUFpQjtBQUNmOUMsUUFBQUEsT0FBTyxDQUFDOEMsTUFBRCxDQUFQO0FBQ0FpTixRQUFBQSxVQUFVLElBQUlBLFVBQVUsQ0FBQ0UsS0FBWCxFQUFkO0FBQ0QsT0FKSCxFQUtFLFVBQVNwSSxLQUFULEVBQWdCO0FBQ2RxQixRQUFBQSxNQUFNLENBQUNyQixLQUFELENBQU47QUFDQWtJLFFBQUFBLFVBQVUsSUFBSUEsVUFBVSxDQUFDRSxLQUFYLENBQWlCcEksS0FBakIsQ0FBZDtBQUNELE9BUkg7QUFVRCxLQWpCSDtBQW1CRCxHQXBCTSxDQUFQO0FBcUJEOztlQUVjdkosUzs7QUFDZjRSLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjdSLFNBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQSBSZXN0V3JpdGUgZW5jYXBzdWxhdGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCB0byBydW4gYW4gb3BlcmF0aW9uXG4vLyB0aGF0IHdyaXRlcyB0byB0aGUgZGF0YWJhc2UuXG4vLyBUaGlzIGNvdWxkIGJlIGVpdGhlciBhIFwiY3JlYXRlXCIgb3IgYW4gXCJ1cGRhdGVcIi5cbmNvbnN0IEFXU1hSYXkgPSByZXF1aXJlKCdodWxhYi14cmF5LXNkaycpO1xuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xudmFyIGRlZXBjb3B5ID0gcmVxdWlyZSgnZGVlcGNvcHknKTtcblxuY29uc3QgQXV0aCA9IHJlcXVpcmUoJy4vQXV0aCcpO1xudmFyIGNyeXB0b1V0aWxzID0gcmVxdWlyZSgnLi9jcnlwdG9VdGlscycpO1xudmFyIHBhc3N3b3JkQ3J5cHRvID0gcmVxdWlyZSgnLi9wYXNzd29yZCcpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpO1xudmFyIHRyaWdnZXJzID0gcmVxdWlyZSgnLi90cmlnZ2VycycpO1xudmFyIENsaWVudFNESyA9IHJlcXVpcmUoJy4vQ2xpZW50U0RLJyk7XG5pbXBvcnQgUmVzdFF1ZXJ5IGZyb20gJy4vUmVzdFF1ZXJ5JztcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4vbG9nZ2VyJztcblxuLy8gcXVlcnkgYW5kIGRhdGEgYXJlIGJvdGggcHJvdmlkZWQgaW4gUkVTVCBBUEkgZm9ybWF0LiBTbyBkYXRhXG4vLyB0eXBlcyBhcmUgZW5jb2RlZCBieSBwbGFpbiBvbGQgb2JqZWN0cy5cbi8vIElmIHF1ZXJ5IGlzIG51bGwsIHRoaXMgaXMgYSBcImNyZWF0ZVwiIGFuZCB0aGUgZGF0YSBpbiBkYXRhIHNob3VsZCBiZVxuLy8gY3JlYXRlZC5cbi8vIE90aGVyd2lzZSB0aGlzIGlzIGFuIFwidXBkYXRlXCIgLSB0aGUgb2JqZWN0IG1hdGNoaW5nIHRoZSBxdWVyeVxuLy8gc2hvdWxkIGdldCB1cGRhdGVkIHdpdGggZGF0YS5cbi8vIFJlc3RXcml0ZSB3aWxsIGhhbmRsZSBvYmplY3RJZCwgY3JlYXRlZEF0LCBhbmQgdXBkYXRlZEF0IGZvclxuLy8gZXZlcnl0aGluZy4gSXQgYWxzbyBrbm93cyB0byB1c2UgdHJpZ2dlcnMgYW5kIHNwZWNpYWwgbW9kaWZpY2F0aW9uc1xuLy8gZm9yIHRoZSBfVXNlciBjbGFzcy5cbmZ1bmN0aW9uIFJlc3RXcml0ZShcbiAgY29uZmlnLFxuICBhdXRoLFxuICBjbGFzc05hbWUsXG4gIHF1ZXJ5LFxuICBkYXRhLFxuICBvcmlnaW5hbERhdGEsXG4gIGNsaWVudFNES1xuKSB7XG4gIGlmIChhdXRoLmlzUmVhZE9ubHkpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgJ0Nhbm5vdCBwZXJmb3JtIGEgd3JpdGUgb3BlcmF0aW9uIHdoZW4gdXNpbmcgcmVhZE9ubHlNYXN0ZXJLZXknXG4gICAgKTtcbiAgfVxuICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgdGhpcy5hdXRoID0gYXV0aDtcbiAgdGhpcy5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gIHRoaXMuY2xpZW50U0RLID0gY2xpZW50U0RLO1xuICB0aGlzLnN0b3JhZ2UgPSB7fTtcbiAgdGhpcy5ydW5PcHRpb25zID0ge307XG4gIHRoaXMuY29udGV4dCA9IHt9O1xuICBpZiAoIXF1ZXJ5ICYmIGRhdGEub2JqZWN0SWQpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgJ29iamVjdElkIGlzIGFuIGludmFsaWQgZmllbGQgbmFtZS4nXG4gICAgKTtcbiAgfVxuICBpZiAoIXF1ZXJ5ICYmIGRhdGEuaWQpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgJ2lkIGlzIGFuIGludmFsaWQgZmllbGQgbmFtZS4nXG4gICAgKTtcbiAgfVxuXG4gIC8vIFdoZW4gdGhlIG9wZXJhdGlvbiBpcyBjb21wbGV0ZSwgdGhpcy5yZXNwb25zZSBtYXkgaGF2ZSBzZXZlcmFsXG4gIC8vIGZpZWxkcy5cbiAgLy8gcmVzcG9uc2U6IHRoZSBhY3R1YWwgZGF0YSB0byBiZSByZXR1cm5lZFxuICAvLyBzdGF0dXM6IHRoZSBodHRwIHN0YXR1cyBjb2RlLiBpZiBub3QgcHJlc2VudCwgdHJlYXRlZCBsaWtlIGEgMjAwXG4gIC8vIGxvY2F0aW9uOiB0aGUgbG9jYXRpb24gaGVhZGVyLiBpZiBub3QgcHJlc2VudCwgbm8gbG9jYXRpb24gaGVhZGVyXG4gIHRoaXMucmVzcG9uc2UgPSBudWxsO1xuXG4gIC8vIFByb2Nlc3NpbmcgdGhpcyBvcGVyYXRpb24gbWF5IG11dGF0ZSBvdXIgZGF0YSwgc28gd2Ugb3BlcmF0ZSBvbiBhXG4gIC8vIGNvcHlcbiAgdGhpcy5xdWVyeSA9IGRlZXBjb3B5KHF1ZXJ5KTtcbiAgdGhpcy5kYXRhID0gZGVlcGNvcHkoZGF0YSk7XG4gIC8vIFdlIG5ldmVyIGNoYW5nZSBvcmlnaW5hbERhdGEsIHNvIHdlIGRvIG5vdCBuZWVkIGEgZGVlcCBjb3B5XG4gIHRoaXMub3JpZ2luYWxEYXRhID0gb3JpZ2luYWxEYXRhO1xuXG4gIC8vIFRoZSB0aW1lc3RhbXAgd2UnbGwgdXNlIGZvciB0aGlzIHdob2xlIG9wZXJhdGlvblxuICB0aGlzLnVwZGF0ZWRBdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSkuaXNvO1xuXG4gIC8vIFNoYXJlZCBTY2hlbWFDb250cm9sbGVyIHRvIGJlIHJldXNlZCB0byByZWR1Y2UgdGhlIG51bWJlciBvZiBsb2FkU2NoZW1hKCkgY2FsbHMgcGVyIHJlcXVlc3RcbiAgLy8gT25jZSBzZXQgdGhlIHNjaGVtYURhdGEgc2hvdWxkIGJlIGltbXV0YWJsZVxuICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlciA9IG51bGw7XG59XG5cbi8vIEEgY29udmVuaWVudCBtZXRob2QgdG8gcGVyZm9ybSBhbGwgdGhlIHN0ZXBzIG9mIHByb2Nlc3NpbmcgdGhlXG4vLyB3cml0ZSwgaW4gb3JkZXIuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSB7cmVzcG9uc2UsIHN0YXR1cywgbG9jYXRpb259IG9iamVjdC5cbi8vIHN0YXR1cyBhbmQgbG9jYXRpb24gYXJlIG9wdGlvbmFsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdnZXRVc2VyQW5kUm9sZUFDTCcsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLmdldFVzZXJBbmRSb2xlQUNMKClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAndmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uKClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnaGFuZGxlSW5zdGFsbGF0aW9uJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMuaGFuZGxlSW5zdGFsbGF0aW9uKClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnaGFuZGxlU2Vzc2lvbicsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLmhhbmRsZVNlc3Npb24oKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICd2YWxpZGF0ZUF1dGhEYXRhJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMudmFsaWRhdGVBdXRoRGF0YSgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3J1bkJlZm9yZVNhdmVUcmlnZ2VyJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucnVuQmVmb3JlU2F2ZVRyaWdnZXIoKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdkZWxldGVFbWFpbFJlc2V0VG9rZW5JZk5lZWRlZCcsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLmRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkKClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAndmFsaWRhdGVTY2hlbWEnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy52YWxpZGF0ZVNjaGVtYSgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlciA9IHNjaGVtYUNvbnRyb2xsZXI7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnc2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCcsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLnNldFJlcXVpcmVkRmllbGRzSWZOZWVkZWQoKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICd0cmFuc2Zvcm1Vc2VyJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMudHJhbnNmb3JtVXNlcigpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ2V4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMoKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdkZXN0cm95RHVwbGljYXRlZFNlc3Npb25zJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMuZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucygpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3J1bkRhdGFiYXNlT3BlcmF0aW9uJyxcbiAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgIHRoaXMucnVuRGF0YWJhc2VPcGVyYXRpb24oKVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAgICdjcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCcsXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkKClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnaGFuZGxlRm9sbG93dXAnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5oYW5kbGVGb2xsb3d1cCgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ3J1bkFmdGVyU2F2ZVRyaWdnZXInLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5ydW5BZnRlclNhdmVUcmlnZ2VyKClcbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJhY2VQcm9taXNlKFxuICAgICAgICAnY2xlYW5Vc2VyQXV0aERhdGEnLFxuICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgdGhpcy5jbGVhblVzZXJBdXRoRGF0YSgpXG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVzcG9uc2U7XG4gICAgfSk7XG59O1xuXG4vLyBVc2VzIHRoZSBBdXRoIG9iamVjdCB0byBnZXQgdGhlIGxpc3Qgb2Ygcm9sZXMsIGFkZHMgdGhlIHVzZXIgaWRcblJlc3RXcml0ZS5wcm90b3R5cGUuZ2V0VXNlckFuZFJvbGVBQ0wgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMucnVuT3B0aW9ucy5hY2wgPSBbJyonXTtcblxuICBpZiAodGhpcy5hdXRoLnVzZXIpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLmdldFVzZXJSb2xlcygpLnRoZW4ocm9sZXMgPT4ge1xuICAgICAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IHRoaXMucnVuT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbXG4gICAgICAgIHRoaXMuYXV0aC51c2VyLmlkLFxuICAgICAgXSk7XG4gICAgICByZXR1cm47XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIGNvbmZpZy5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uID0gZnVuY3Rpb24oKSB7XG4gIGlmIChcbiAgICB0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmXG4gICAgIXRoaXMuYXV0aC5pc01hc3RlciAmJlxuICAgIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTFcbiAgKSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgJ1RoaXMgdXNlciBpcyBub3QgYWxsb3dlZCB0byBhY2Nlc3MgJyArXG4gICAgICAgICAgICAgICdub24tZXhpc3RlbnQgY2xhc3M6ICcgK1xuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIHNjaGVtYS5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVTY2hlbWEgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnZhbGlkYXRlT2JqZWN0KFxuICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgIHRoaXMuZGF0YSxcbiAgICB0aGlzLnF1ZXJ5LFxuICAgIHRoaXMucnVuT3B0aW9uc1xuICApO1xufTtcblxuLy8gUnVucyBhbnkgYmVmb3JlU2F2ZSB0cmlnZ2VycyBhZ2FpbnN0IHRoaXMgb3BlcmF0aW9uLlxuLy8gQW55IGNoYW5nZSBsZWFkcyB0byBvdXIgZGF0YSBiZWluZyBtdXRhdGVkLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5CZWZvcmVTYXZlVHJpZ2dlciA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2JlZm9yZVNhdmUnIHRyaWdnZXIgZm9yIHRoaXMgY2xhc3MuXG4gIGlmIChcbiAgICAhdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgICApXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIC8vIENsb3VkIGNvZGUgZ2V0cyBhIGJpdCBvZiBleHRyYSBkYXRhIGZvciBpdHMgb2JqZWN0c1xuICB2YXIgZXh0cmFEYXRhID0geyBjbGFzc05hbWU6IHRoaXMuY2xhc3NOYW1lIH07XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBleHRyYURhdGEub2JqZWN0SWQgPSB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICB9XG5cbiAgbGV0IG9yaWdpbmFsT2JqZWN0ID0gbnVsbDtcbiAgY29uc3QgdXBkYXRlZE9iamVjdCA9IHRoaXMuYnVpbGRVcGRhdGVkT2JqZWN0KGV4dHJhRGF0YSk7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAvLyBUaGlzIGlzIGFuIHVwZGF0ZSBmb3IgZXhpc3Rpbmcgb2JqZWN0LlxuICAgIG9yaWdpbmFsT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgfVxuXG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIEJlZm9yZSBjYWxsaW5nIHRoZSB0cmlnZ2VyLCB2YWxpZGF0ZSB0aGUgcGVybWlzc2lvbnMgZm9yIHRoZSBzYXZlIG9wZXJhdGlvblxuICAgICAgbGV0IGRhdGFiYXNlUHJvbWlzZSA9IG51bGw7XG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgdXBkYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgY3JlYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UuY3JlYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgdHJ1ZVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gSW4gdGhlIGNhc2UgdGhhdCB0aGVyZSBpcyBubyBwZXJtaXNzaW9uIGZvciB0aGUgb3BlcmF0aW9uLCBpdCB0aHJvd3MgYW4gZXJyb3JcbiAgICAgIHJldHVybiBkYXRhYmFzZVByb21pc2UudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICBpZiAoIXJlc3VsdCB8fCByZXN1bHQubGVuZ3RoIDw9IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgICAgJ09iamVjdCBub3QgZm91bmQuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyaWdnZXJzLm1heWJlUnVuVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgICAgdGhpcy5hdXRoLFxuICAgICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgdGhpcy5jb25maWcsXG4gICAgICAgIHRoaXMuY29udGV4dFxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSBfLnJlZHVjZShcbiAgICAgICAgICByZXNwb25zZS5vYmplY3QsXG4gICAgICAgICAgKHJlc3VsdCwgdmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRXF1YWwodGhpcy5kYXRhW2tleV0sIHZhbHVlKSkge1xuICAgICAgICAgICAgICByZXN1bHQucHVzaChrZXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICB9LFxuICAgICAgICAgIFtdXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGF0YSA9IHJlc3BvbnNlLm9iamVjdDtcbiAgICAgICAgLy8gV2Ugc2hvdWxkIGRlbGV0ZSB0aGUgb2JqZWN0SWQgZm9yIGFuIHVwZGF0ZSB3cml0ZVxuICAgICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5CZWZvcmVMb2dpblRyaWdnZXIgPSBhc3luYyBmdW5jdGlvbih1c2VyRGF0YSkge1xuICAvLyBBdm9pZCBkb2luZyBhbnkgc2V0dXAgZm9yIHRyaWdnZXJzIGlmIHRoZXJlIGlzIG5vICdiZWZvcmVMb2dpbicgdHJpZ2dlclxuICBpZiAoXG4gICAgIXRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUxvZ2luLFxuICAgICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICAgIClcbiAgKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQ2xvdWQgY29kZSBnZXRzIGEgYml0IG9mIGV4dHJhIGRhdGEgZm9yIGl0cyBvYmplY3RzXG4gIGNvbnN0IGV4dHJhRGF0YSA9IHsgY2xhc3NOYW1lOiB0aGlzLmNsYXNzTmFtZSB9O1xuICBjb25zdCB1c2VyID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHVzZXJEYXRhKTtcblxuICAvLyBubyBuZWVkIHRvIHJldHVybiBhIHJlc3BvbnNlXG4gIGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuVHJpZ2dlcihcbiAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVMb2dpbixcbiAgICB0aGlzLmF1dGgsXG4gICAgdXNlcixcbiAgICBudWxsLFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuY29udGV4dFxuICApO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5zZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmRhdGEpIHtcbiAgICByZXR1cm4gdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXIuZ2V0QWxsQ2xhc3NlcygpLnRoZW4oYWxsQ2xhc3NlcyA9PiB7XG4gICAgICBjb25zdCBzY2hlbWEgPSBhbGxDbGFzc2VzLmZpbmQoXG4gICAgICAgIG9uZUNsYXNzID0+IG9uZUNsYXNzLmNsYXNzTmFtZSA9PT0gdGhpcy5jbGFzc05hbWVcbiAgICAgICk7XG4gICAgICBjb25zdCBzZXRSZXF1aXJlZEZpZWxkSWZOZWVkZWQgPSAoZmllbGROYW1lLCBzZXREZWZhdWx0KSA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkIHx8XG4gICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IG51bGwgfHxcbiAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gJycgfHxcbiAgICAgICAgICAodHlwZW9mIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0uX19vcCA9PT0gJ0RlbGV0ZScpXG4gICAgICAgICkge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHNldERlZmF1bHQgJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZSAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZSAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICAgICAodGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IHVuZGVmaW5lZCB8fFxuICAgICAgICAgICAgICAodHlwZW9mIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdLl9fb3AgPT09ICdEZWxldGUnKSlcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID0gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZTtcbiAgICAgICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyID1cbiAgICAgICAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgfHwgW107XG4gICAgICAgICAgICBpZiAodGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuaW5kZXhPZihmaWVsZE5hbWUpIDwgMCkge1xuICAgICAgICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlci5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJlcXVpcmVkID09PSB0cnVlXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgIGAke2ZpZWxkTmFtZX0gaXMgcmVxdWlyZWRgXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgLy8gQWRkIGRlZmF1bHQgZmllbGRzXG4gICAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG4gICAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuXG4gICAgICAgIC8vIE9ubHkgYXNzaWduIG5ldyBvYmplY3RJZCBpZiB3ZSBhcmUgY3JlYXRpbmcgbmV3IG9iamVjdFxuICAgICAgICBpZiAoIXRoaXMuZGF0YS5vYmplY3RJZCkge1xuICAgICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCA9IGNyeXB0b1V0aWxzLm5ld09iamVjdElkKFxuICAgICAgICAgICAgdGhpcy5jb25maWcub2JqZWN0SWRTaXplXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2NoZW1hKSB7XG4gICAgICAgICAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgc2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkKGZpZWxkTmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoc2NoZW1hKSB7XG4gICAgICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YSkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgIHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZChmaWVsZE5hbWUsIGZhbHNlKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuLy8gVHJhbnNmb3JtcyBhdXRoIGRhdGEgZm9yIGEgdXNlciBvYmplY3QuXG4vLyBEb2VzIG5vdGhpbmcgaWYgdGhpcyBpc24ndCBhIHVzZXIgb2JqZWN0LlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUF1dGhEYXRhID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgaWYgKFxuICAgICAgdHlwZW9mIHRoaXMuZGF0YS51c2VybmFtZSAhPT0gJ3N0cmluZycgfHxcbiAgICAgIF8uaXNFbXB0eSh0aGlzLmRhdGEudXNlcm5hbWUpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX01JU1NJTkcsXG4gICAgICAgICdiYWQgb3IgbWlzc2luZyB1c2VybmFtZSdcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIHR5cGVvZiB0aGlzLmRhdGEucGFzc3dvcmQgIT09ICdzdHJpbmcnIHx8XG4gICAgICBfLmlzRW1wdHkodGhpcy5kYXRhLnBhc3N3b3JkKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5QQVNTV09SRF9NSVNTSU5HLFxuICAgICAgICAncGFzc3dvcmQgaXMgcmVxdWlyZWQnXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGlmICghdGhpcy5kYXRhLmF1dGhEYXRhIHx8ICFPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBhdXRoRGF0YSA9IHRoaXMuZGF0YS5hdXRoRGF0YTtcbiAgdmFyIHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgaWYgKHByb3ZpZGVycy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY2FuSGFuZGxlQXV0aERhdGEgPSBwcm92aWRlcnMucmVkdWNlKChjYW5IYW5kbGUsIHByb3ZpZGVyKSA9PiB7XG4gICAgICB2YXIgcHJvdmlkZXJBdXRoRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgIHZhciBoYXNUb2tlbiA9IHByb3ZpZGVyQXV0aERhdGEgJiYgcHJvdmlkZXJBdXRoRGF0YS5pZDtcbiAgICAgIHJldHVybiBjYW5IYW5kbGUgJiYgKGhhc1Rva2VuIHx8IHByb3ZpZGVyQXV0aERhdGEgPT0gbnVsbCk7XG4gICAgfSwgdHJ1ZSk7XG4gICAgaWYgKGNhbkhhbmRsZUF1dGhEYXRhKSB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoRGF0YShhdXRoRGF0YSk7XG4gICAgfVxuICB9XG4gIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiA9IGZ1bmN0aW9uKGF1dGhEYXRhKSB7XG4gIGNvbnN0IHZhbGlkYXRpb25zID0gT2JqZWN0LmtleXMoYXV0aERhdGEpLm1hcChwcm92aWRlciA9PiB7XG4gICAgaWYgKGF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICBjb25zdCB2YWxpZGF0ZUF1dGhEYXRhID0gdGhpcy5jb25maWcuYXV0aERhdGFNYW5hZ2VyLmdldFZhbGlkYXRvckZvclByb3ZpZGVyKFxuICAgICAgcHJvdmlkZXJcbiAgICApO1xuICAgIGlmICghdmFsaWRhdGVBdXRoRGF0YSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5VTlNVUFBPUlRFRF9TRVJWSUNFLFxuICAgICAgICAnVGhpcyBhdXRoZW50aWNhdGlvbiBtZXRob2QgaXMgdW5zdXBwb3J0ZWQuJ1xuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbGlkYXRlQXV0aERhdGEoYXV0aERhdGFbcHJvdmlkZXJdKTtcbiAgfSk7XG4gIHJldHVybiBQcm9taXNlLmFsbCh2YWxpZGF0aW9ucyk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbmRVc2Vyc1dpdGhBdXRoRGF0YSA9IGZ1bmN0aW9uKGF1dGhEYXRhKSB7XG4gIGNvbnN0IHByb3ZpZGVycyA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKTtcbiAgY29uc3QgcXVlcnkgPSBwcm92aWRlcnNcbiAgICAucmVkdWNlKChtZW1vLCBwcm92aWRlcikgPT4ge1xuICAgICAgaWYgKCFhdXRoRGF0YVtwcm92aWRlcl0pIHtcbiAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICB9XG4gICAgICBjb25zdCBxdWVyeUtleSA9IGBhdXRoRGF0YS4ke3Byb3ZpZGVyfS5pZGA7XG4gICAgICBjb25zdCBxdWVyeSA9IHt9O1xuICAgICAgcXVlcnlbcXVlcnlLZXldID0gYXV0aERhdGFbcHJvdmlkZXJdLmlkO1xuICAgICAgbWVtby5wdXNoKHF1ZXJ5KTtcbiAgICAgIHJldHVybiBtZW1vO1xuICAgIH0sIFtdKVxuICAgIC5maWx0ZXIocSA9PiB7XG4gICAgICByZXR1cm4gdHlwZW9mIHEgIT09ICd1bmRlZmluZWQnO1xuICAgIH0pO1xuXG4gIGxldCBmaW5kUHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZShbXSk7XG4gIGlmIChxdWVyeS5sZW5ndGggPiAwKSB7XG4gICAgZmluZFByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKHRoaXMuY2xhc3NOYW1lLCB7ICRvcjogcXVlcnkgfSwge30pO1xuICB9XG5cbiAgcmV0dXJuIGZpbmRQcm9taXNlO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5maWx0ZXJlZE9iamVjdHNCeUFDTCA9IGZ1bmN0aW9uKG9iamVjdHMpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHJldHVybiBvYmplY3RzO1xuICB9XG4gIHJldHVybiBvYmplY3RzLmZpbHRlcihvYmplY3QgPT4ge1xuICAgIGlmICghb2JqZWN0LkFDTCkge1xuICAgICAgcmV0dXJuIHRydWU7IC8vIGxlZ2FjeSB1c2VycyB0aGF0IGhhdmUgbm8gQUNMIGZpZWxkIG9uIHRoZW1cbiAgICB9XG4gICAgLy8gUmVndWxhciB1c2VycyB0aGF0IGhhdmUgYmVlbiBsb2NrZWQgb3V0LlxuICAgIHJldHVybiBvYmplY3QuQUNMICYmIE9iamVjdC5rZXlzKG9iamVjdC5BQ0wpLmxlbmd0aCA+IDA7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVBdXRoRGF0YSA9IGZ1bmN0aW9uKGF1dGhEYXRhKSB7XG4gIGxldCByZXN1bHRzO1xuICByZXR1cm4gdGhpcy5maW5kVXNlcnNXaXRoQXV0aERhdGEoYXV0aERhdGEpLnRoZW4oYXN5bmMgciA9PiB7XG4gICAgcmVzdWx0cyA9IHRoaXMuZmlsdGVyZWRPYmplY3RzQnlBQ0wocik7XG5cbiAgICBpZiAocmVzdWx0cy5sZW5ndGggPT0gMSkge1xuICAgICAgdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKS5qb2luKCcsJyk7XG5cbiAgICAgIGNvbnN0IHVzZXJSZXN1bHQgPSByZXN1bHRzWzBdO1xuICAgICAgY29uc3QgbXV0YXRlZEF1dGhEYXRhID0ge307XG4gICAgICBPYmplY3Qua2V5cyhhdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgIGNvbnN0IHByb3ZpZGVyRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgY29uc3QgdXNlckF1dGhEYXRhID0gdXNlclJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl07XG5cbiAgICAgICAgY29uc3QgZXF1YWxBdXRoRGF0YSA9IHRoaXMuY29uZmlnLmF1dGhEYXRhTWFuYWdlci5nZXRFcXVhbGl0eUZvclByb3ZpZGVyKHByb3ZpZGVyKSB8fCBfLmlzRXF1YWw7XG5cbiAgICAgICAgaWYgKCFlcXVhbEF1dGhEYXRhKHByb3ZpZGVyRGF0YSwgdXNlckF1dGhEYXRhKSkge1xuICAgICAgICAgIG11dGF0ZWRBdXRoRGF0YVtwcm92aWRlcl0gPSBwcm92aWRlckRhdGE7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFzTXV0YXRlZEF1dGhEYXRhID0gT2JqZWN0LmtleXMobXV0YXRlZEF1dGhEYXRhKS5sZW5ndGggIT09IDA7XG4gICAgICBsZXQgdXNlcklkO1xuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICB1c2VySWQgPSB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICAgICAgfSBlbHNlIGlmICh0aGlzLmF1dGggJiYgdGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICAgICAgdXNlcklkID0gdGhpcy5hdXRoLnVzZXIuaWQ7XG4gICAgICB9XG4gICAgICBpZiAoIXVzZXJJZCB8fCB1c2VySWQgPT09IHVzZXJSZXN1bHQub2JqZWN0SWQpIHtcbiAgICAgICAgLy8gbm8gdXNlciBtYWtpbmcgdGhlIGNhbGxcbiAgICAgICAgLy8gT1IgdGhlIHVzZXIgbWFraW5nIHRoZSBjYWxsIGlzIHRoZSByaWdodCBvbmVcbiAgICAgICAgLy8gTG9naW4gd2l0aCBhdXRoIGRhdGFcbiAgICAgICAgZGVsZXRlIHJlc3VsdHNbMF0ucGFzc3dvcmQ7XG5cbiAgICAgICAgLy8gbmVlZCB0byBzZXQgdGhlIG9iamVjdElkIGZpcnN0IG90aGVyd2lzZSBsb2NhdGlvbiBoYXMgdHJhaWxpbmcgdW5kZWZpbmVkXG4gICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCA9IHVzZXJSZXN1bHQub2JqZWN0SWQ7XG5cbiAgICAgICAgaWYgKCF0aGlzLnF1ZXJ5IHx8ICF0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgLy8gdGhpcyBhIGxvZ2luIGNhbGwsIG5vIHVzZXJJZCBwYXNzZWRcbiAgICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgICAgcmVzcG9uc2U6IHVzZXJSZXN1bHQsXG4gICAgICAgICAgICBsb2NhdGlvbjogdGhpcy5sb2NhdGlvbigpLFxuICAgICAgICAgIH07XG4gICAgICAgICAgLy8gUnVuIGJlZm9yZUxvZ2luIGhvb2sgYmVmb3JlIHN0b3JpbmcgYW55IHVwZGF0ZXNcbiAgICAgICAgICAvLyB0byBhdXRoRGF0YSBvbiB0aGUgZGI7IGNoYW5nZXMgdG8gdXNlclJlc3VsdFxuICAgICAgICAgIC8vIHdpbGwgYmUgaWdub3JlZC5cbiAgICAgICAgICBhd2FpdCB0aGlzLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlcihkZWVwY29weSh1c2VyUmVzdWx0KSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB3ZSBkaWRuJ3QgY2hhbmdlIHRoZSBhdXRoIGRhdGEsIGp1c3Qga2VlcCBnb2luZ1xuICAgICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICAvLyBXZSBoYXZlIGF1dGhEYXRhIHRoYXQgaXMgdXBkYXRlZCBvbiBsb2dpblxuICAgICAgICAvLyB0aGF0IGNhbiBoYXBwZW4gd2hlbiB0b2tlbiBhcmUgcmVmcmVzaGVkLFxuICAgICAgICAvLyBXZSBzaG91bGQgdXBkYXRlIHRoZSB0b2tlbiBhbmQgbGV0IHRoZSB1c2VyIGluXG4gICAgICAgIC8vIFdlIHNob3VsZCBvbmx5IGNoZWNrIHRoZSBtdXRhdGVkIGtleXNcbiAgICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKG11dGF0ZWRBdXRoRGF0YSkudGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgICAgLy8gSUYgd2UgaGF2ZSBhIHJlc3BvbnNlLCB3ZSdsbCBza2lwIHRoZSBkYXRhYmFzZSBvcGVyYXRpb24gLyBiZWZvcmVTYXZlIC8gYWZ0ZXJTYXZlIGV0Yy4uLlxuICAgICAgICAgIC8vIHdlIG5lZWQgdG8gc2V0IGl0IHVwIHRoZXJlLlxuICAgICAgICAgIC8vIFdlIGFyZSBzdXBwb3NlZCB0byBoYXZlIGEgcmVzcG9uc2Ugb25seSBvbiBMT0dJTiB3aXRoIGF1dGhEYXRhLCBzbyB3ZSBza2lwIHRob3NlXG4gICAgICAgICAgLy8gSWYgd2UncmUgbm90IGxvZ2dpbmcgaW4sIGJ1dCBqdXN0IHVwZGF0aW5nIHRoZSBjdXJyZW50IHVzZXIsIHdlIGNhbiBzYWZlbHkgc2tpcCB0aGF0IHBhcnRcbiAgICAgICAgICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgICAgICAgICAgLy8gQXNzaWduIHRoZSBuZXcgYXV0aERhdGEgaW4gdGhlIHJlc3BvbnNlXG4gICAgICAgICAgICBPYmplY3Qua2V5cyhtdXRhdGVkQXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLmF1dGhEYXRhW3Byb3ZpZGVyXSA9XG4gICAgICAgICAgICAgICAgbXV0YXRlZEF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBSdW4gdGhlIERCIHVwZGF0ZSBkaXJlY3RseSwgYXMgJ21hc3RlcidcbiAgICAgICAgICAgIC8vIEp1c3QgdXBkYXRlIHRoZSBhdXRoRGF0YSBwYXJ0XG4gICAgICAgICAgICAvLyBUaGVuIHdlJ3JlIGdvb2QgZm9yIHRoZSB1c2VyLCBlYXJseSBleGl0IG9mIHNvcnRzXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgeyBvYmplY3RJZDogdGhpcy5kYXRhLm9iamVjdElkIH0sXG4gICAgICAgICAgICAgIHsgYXV0aERhdGE6IG11dGF0ZWRBdXRoRGF0YSB9LFxuICAgICAgICAgICAgICB7fVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmICh1c2VySWQpIHtcbiAgICAgICAgLy8gVHJ5aW5nIHRvIHVwZGF0ZSBhdXRoIGRhdGEgYnV0IHVzZXJzXG4gICAgICAgIC8vIGFyZSBkaWZmZXJlbnRcbiAgICAgICAgaWYgKHVzZXJSZXN1bHQub2JqZWN0SWQgIT09IHVzZXJJZCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsXG4gICAgICAgICAgICAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCdcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIE5vIGF1dGggZGF0YSB3YXMgbXV0YXRlZCwganVzdCBrZWVwIGdvaW5nXG4gICAgICAgIGlmICghaGFzTXV0YXRlZEF1dGhEYXRhKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihhdXRoRGF0YSkudGhlbigoKSA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIC8vIE1vcmUgdGhhbiAxIHVzZXIgd2l0aCB0aGUgcGFzc2VkIGlkJ3NcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsXG4gICAgICAgICAgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufTtcblxuLy8gVGhlIG5vbi10aGlyZC1wYXJ0eSBwYXJ0cyBvZiBVc2VyIHRyYW5zZm9ybWF0aW9uXG5SZXN0V3JpdGUucHJvdG90eXBlLnRyYW5zZm9ybVVzZXIgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyICYmICdlbWFpbFZlcmlmaWVkJyBpbiB0aGlzLmRhdGEpIHtcbiAgICBjb25zdCBlcnJvciA9IGBDbGllbnRzIGFyZW4ndCBhbGxvd2VkIHRvIG1hbnVhbGx5IHVwZGF0ZSBlbWFpbCB2ZXJpZmljYXRpb24uYDtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTiwgZXJyb3IpO1xuICB9XG5cbiAgLy8gRG8gbm90IGNsZWFudXAgc2Vzc2lvbiBpZiBvYmplY3RJZCBpcyBub3Qgc2V0XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMub2JqZWN0SWQoKSkge1xuICAgIC8vIElmIHdlJ3JlIHVwZGF0aW5nIGEgX1VzZXIgb2JqZWN0LCB3ZSBuZWVkIHRvIGNsZWFyIG91dCB0aGUgY2FjaGUgZm9yIHRoYXQgdXNlci4gRmluZCBhbGwgdGhlaXJcbiAgICAvLyBzZXNzaW9uIHRva2VucywgYW5kIHJlbW92ZSB0aGVtIGZyb20gdGhlIGNhY2hlLlxuICAgIHByb21pc2UgPSBuZXcgUmVzdFF1ZXJ5KHRoaXMuY29uZmlnLCBBdXRoLm1hc3Rlcih0aGlzLmNvbmZpZyksICdfU2Vzc2lvbicsIHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICAgIH0sXG4gICAgfSlcbiAgICAgIC5leGVjdXRlKClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICByZXN1bHRzLnJlc3VsdHMuZm9yRWFjaChzZXNzaW9uID0+XG4gICAgICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnVzZXIuZGVsKHNlc3Npb24uc2Vzc2lvblRva2VuKVxuICAgICAgICApO1xuICAgICAgfSk7XG4gIH1cblxuICByZXR1cm4gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIFRyYW5zZm9ybSB0aGUgcGFzc3dvcmRcbiAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBpZ25vcmUgb25seSBpZiB1bmRlZmluZWQuIHNob3VsZCBwcm9jZWVkIGlmIGVtcHR5ICgnJylcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSA9IHRydWU7XG4gICAgICAgIC8vIEdlbmVyYXRlIGEgbmV3IHNlc3Npb24gb25seSBpZiB0aGUgdXNlciByZXF1ZXN0ZWRcbiAgICAgICAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICAgICAgICB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uaGFzaCh0aGlzLmRhdGEucGFzc3dvcmQpLnRoZW4oaGFzaGVkUGFzc3dvcmQgPT4ge1xuICAgICAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkID0gaGFzaGVkUGFzc3dvcmQ7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVVzZXJOYW1lKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVFbWFpbCgpO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVVc2VyTmFtZSA9IGZ1bmN0aW9uKCkge1xuICAvLyBDaGVjayBmb3IgdXNlcm5hbWUgdW5pcXVlbmVzc1xuICBpZiAoIXRoaXMuZGF0YS51c2VybmFtZSkge1xuICAgIGlmICghdGhpcy5xdWVyeSkge1xuICAgICAgdGhpcy5kYXRhLnVzZXJuYW1lID0gY3J5cHRvVXRpbHMucmFuZG9tU3RyaW5nKDI1KTtcbiAgICAgIHRoaXMucmVzcG9uc2VTaG91bGRIYXZlVXNlcm5hbWUgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gV2UgbmVlZCB0byBhIGZpbmQgdG8gY2hlY2sgZm9yIGR1cGxpY2F0ZSB1c2VybmFtZSBpbiBjYXNlIHRoZXkgYXJlIG1pc3NpbmcgdGhlIHVuaXF1ZSBpbmRleCBvbiB1c2VybmFtZXNcbiAgLy8gVE9ETzogQ2hlY2sgaWYgdGhlcmUgaXMgYSB1bmlxdWUgaW5kZXgsIGFuZCBpZiBzbywgc2tpcCB0aGlzIHF1ZXJ5LlxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZChcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgeyB1c2VybmFtZTogdGhpcy5kYXRhLnVzZXJuYW1lLCBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9IH0sXG4gICAgICB7IGxpbWl0OiAxIH0sXG4gICAgICB7fSxcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfVEFLRU4sXG4gICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVFbWFpbCA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMuZGF0YS5lbWFpbCB8fCB0aGlzLmRhdGEuZW1haWwuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gVmFsaWRhdGUgYmFzaWMgZW1haWwgYWRkcmVzcyBmb3JtYXRcbiAgaWYgKCF0aGlzLmRhdGEuZW1haWwubWF0Y2goL14uK0AuKyQvKSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9FTUFJTF9BRERSRVNTLFxuICAgICAgICAnRW1haWwgYWRkcmVzcyBmb3JtYXQgaXMgaW52YWxpZC4nXG4gICAgICApXG4gICAgKTtcbiAgfVxuICAvLyBTYW1lIHByb2JsZW0gZm9yIGVtYWlsIGFzIGFib3ZlIGZvciB1c2VybmFtZVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZChcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgeyBlbWFpbDogdGhpcy5kYXRhLmVtYWlsLCBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9IH0sXG4gICAgICB7IGxpbWl0OiAxIH0sXG4gICAgICB7fSxcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgICF0aGlzLmRhdGEuYXV0aERhdGEgfHxcbiAgICAgICAgIU9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoIHx8XG4gICAgICAgIChPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCA9PT0gMSAmJlxuICAgICAgICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSlbMF0gPT09ICdhbm9ueW1vdXMnKVxuICAgICAgKSB7XG4gICAgICAgIC8vIFdlIHVwZGF0ZWQgdGhlIGVtYWlsLCBzZW5kIGEgbmV3IHZhbGlkYXRpb25cbiAgICAgICAgdGhpcy5zdG9yYWdlWydzZW5kVmVyaWZpY2F0aW9uRW1haWwnXSA9IHRydWU7XG4gICAgICAgIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNldEVtYWlsVmVyaWZ5VG9rZW4odGhpcy5kYXRhKTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cygpLnRoZW4oKCkgPT4ge1xuICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSgpO1xuICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMgPSBmdW5jdGlvbigpIHtcbiAgLy8gY2hlY2sgaWYgdGhlIHBhc3N3b3JkIGNvbmZvcm1zIHRvIHRoZSBkZWZpbmVkIHBhc3N3b3JkIHBvbGljeSBpZiBjb25maWd1cmVkXG4gIC8vIElmIHdlIHNwZWNpZmllZCBhIGN1c3RvbSBlcnJvciBpbiBvdXIgY29uZmlndXJhdGlvbiB1c2UgaXQuXG4gIC8vIEV4YW1wbGU6IFwiUGFzc3dvcmRzIG11c3QgaW5jbHVkZSBhIENhcGl0YWwgTGV0dGVyLCBMb3dlcmNhc2UgTGV0dGVyLCBhbmQgYSBudW1iZXIuXCJcbiAgLy9cbiAgLy8gVGhpcyBpcyBlc3BlY2lhbGx5IHVzZWZ1bCBvbiB0aGUgZ2VuZXJpYyBcInBhc3N3b3JkIHJlc2V0XCIgcGFnZSxcbiAgLy8gYXMgaXQgYWxsb3dzIHRoZSBwcm9ncmFtbWVyIHRvIGNvbW11bmljYXRlIHNwZWNpZmljIHJlcXVpcmVtZW50cyBpbnN0ZWFkIG9mOlxuICAvLyBhLiBtYWtpbmcgdGhlIHVzZXIgZ3Vlc3Mgd2hhdHMgd3JvbmdcbiAgLy8gYi4gbWFraW5nIGEgY3VzdG9tIHBhc3N3b3JkIHJlc2V0IHBhZ2UgdGhhdCBzaG93cyB0aGUgcmVxdWlyZW1lbnRzXG4gIGNvbnN0IHBvbGljeUVycm9yID0gdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdGlvbkVycm9yXG4gICAgPyB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0aW9uRXJyb3JcbiAgICA6ICdQYXNzd29yZCBkb2VzIG5vdCBtZWV0IHRoZSBQYXNzd29yZCBQb2xpY3kgcmVxdWlyZW1lbnRzLic7XG4gIGNvbnN0IGNvbnRhaW5zVXNlcm5hbWVFcnJvciA9ICdQYXNzd29yZCBjYW5ub3QgY29udGFpbiB5b3VyIHVzZXJuYW1lLic7XG5cbiAgLy8gY2hlY2sgd2hldGhlciB0aGUgcGFzc3dvcmQgbWVldHMgdGhlIHBhc3N3b3JkIHN0cmVuZ3RoIHJlcXVpcmVtZW50c1xuICBpZiAoXG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnBhdHRlcm5WYWxpZGF0b3IgJiZcbiAgICAgICF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yKHRoaXMuZGF0YS5wYXNzd29yZCkpIHx8XG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRvckNhbGxiYWNrICYmXG4gICAgICAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sodGhpcy5kYXRhLnBhc3N3b3JkKSlcbiAgKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIHBvbGljeUVycm9yKVxuICAgICk7XG4gIH1cblxuICAvLyBjaGVjayB3aGV0aGVyIHBhc3N3b3JkIGNvbnRhaW4gdXNlcm5hbWVcbiAgaWYgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LmRvTm90QWxsb3dVc2VybmFtZSA9PT0gdHJ1ZSkge1xuICAgIGlmICh0aGlzLmRhdGEudXNlcm5hbWUpIHtcbiAgICAgIC8vIHVzZXJuYW1lIGlzIG5vdCBwYXNzZWQgZHVyaW5nIHBhc3N3b3JkIHJlc2V0XG4gICAgICBpZiAodGhpcy5kYXRhLnBhc3N3b3JkLmluZGV4T2YodGhpcy5kYXRhLnVzZXJuYW1lKSA+PSAwKVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIGNvbnRhaW5zVXNlcm5hbWVFcnJvcilcbiAgICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gcmV0cmlldmUgdGhlIFVzZXIgb2JqZWN0IHVzaW5nIG9iamVjdElkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgIC5maW5kKCdfVXNlcicsIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9KVxuICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggIT0gMSkge1xuICAgICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodGhpcy5kYXRhLnBhc3N3b3JkLmluZGV4T2YocmVzdWx0c1swXS51c2VybmFtZSkgPj0gMClcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgICAgY29udGFpbnNVc2VybmFtZUVycm9yXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkgPSBmdW5jdGlvbigpIHtcbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBpcyByZXBlYXRpbmcgZnJvbSBzcGVjaWZpZWQgaGlzdG9yeVxuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkpIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5maW5kKFxuICAgICAgICAnX1VzZXInLFxuICAgICAgICB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgeyBrZXlzOiBbJ19wYXNzd29yZF9oaXN0b3J5JywgJ19oYXNoZWRfcGFzc3dvcmQnXSB9XG4gICAgICApXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgIGxldCBvbGRQYXNzd29yZHMgPSBbXTtcbiAgICAgICAgaWYgKHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnkpXG4gICAgICAgICAgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgICAgdXNlci5fcGFzc3dvcmRfaGlzdG9yeSxcbiAgICAgICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDFcbiAgICAgICAgICApO1xuICAgICAgICBvbGRQYXNzd29yZHMucHVzaCh1c2VyLnBhc3N3b3JkKTtcbiAgICAgICAgY29uc3QgbmV3UGFzc3dvcmQgPSB0aGlzLmRhdGEucGFzc3dvcmQ7XG4gICAgICAgIC8vIGNvbXBhcmUgdGhlIG5ldyBwYXNzd29yZCBoYXNoIHdpdGggYWxsIG9sZCBwYXNzd29yZCBoYXNoZXNcbiAgICAgICAgY29uc3QgcHJvbWlzZXMgPSBvbGRQYXNzd29yZHMubWFwKGZ1bmN0aW9uKGhhc2gpIHtcbiAgICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uY29tcGFyZShuZXdQYXNzd29yZCwgaGFzaCkudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdClcbiAgICAgICAgICAgICAgLy8gcmVqZWN0IGlmIHRoZXJlIGlzIGEgbWF0Y2hcbiAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KCdSRVBFQVRfUEFTU1dPUkQnKTtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIHdhaXQgZm9yIGFsbCBjb21wYXJpc29ucyB0byBjb21wbGV0ZVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwocHJvbWlzZXMpXG4gICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyID09PSAnUkVQRUFUX1BBU1NXT1JEJylcbiAgICAgICAgICAgICAgLy8gYSBtYXRjaCB3YXMgZm91bmRcbiAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgICAgICBgTmV3IHBhc3N3b3JkIHNob3VsZCBub3QgYmUgdGhlIHNhbWUgYXMgbGFzdCAke3RoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeX0gcGFzc3dvcmRzLmBcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEb24ndCBnZW5lcmF0ZSBzZXNzaW9uIGZvciB1cGRhdGluZyB1c2VyICh0aGlzLnF1ZXJ5IGlzIHNldCkgdW5sZXNzIGF1dGhEYXRhIGV4aXN0c1xuICBpZiAodGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERvbid0IGdlbmVyYXRlIG5ldyBzZXNzaW9uVG9rZW4gaWYgbGlua2luZyB2aWEgc2Vzc2lvblRva2VuXG4gIGlmICh0aGlzLmF1dGgudXNlciAmJiB0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgICF0aGlzLnN0b3JhZ2VbJ2F1dGhQcm92aWRlciddICYmIC8vIHNpZ251cCBjYWxsLCB3aXRoXG4gICAgdGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCAmJiAvLyBubyBsb2dpbiB3aXRob3V0IHZlcmlmaWNhdGlvblxuICAgIHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHNcbiAgKSB7XG4gICAgLy8gdmVyaWZpY2F0aW9uIGlzIG9uXG4gICAgcmV0dXJuOyAvLyBkbyBub3QgY3JlYXRlIHRoZSBzZXNzaW9uIHRva2VuIGluIHRoYXQgY2FzZSFcbiAgfVxuICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW4oKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY3JlYXRlU2Vzc2lvblRva2VuID0gYXN5bmMgZnVuY3Rpb24oKSB7XG4gIC8vIGNsb3VkIGluc3RhbGxhdGlvbklkIGZyb20gQ2xvdWQgQ29kZSxcbiAgLy8gbmV2ZXIgY3JlYXRlIHNlc3Npb24gdG9rZW5zIGZyb20gdGhlcmUuXG4gIGlmICh0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQgJiYgdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkID09PSAnY2xvdWQnKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgeyBzZXNzaW9uRGF0YSwgY3JlYXRlU2Vzc2lvbiB9ID0gQXV0aC5jcmVhdGVTZXNzaW9uKHRoaXMuY29uZmlnLCB7XG4gICAgdXNlcklkOiB0aGlzLm9iamVjdElkKCksXG4gICAgY3JlYXRlZFdpdGg6IHtcbiAgICAgIGFjdGlvbjogdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSA/ICdsb2dpbicgOiAnc2lnbnVwJyxcbiAgICAgIGF1dGhQcm92aWRlcjogdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSB8fCAncGFzc3dvcmQnLFxuICAgIH0sXG4gICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgfSk7XG5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2Uuc2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcbn07XG5cbi8vIERlbGV0ZSBlbWFpbCByZXNldCB0b2tlbnMgaWYgdXNlciBpcyBjaGFuZ2luZyBwYXNzd29yZCBvciBlbWFpbC5cblJlc3RXcml0ZS5wcm90b3R5cGUuZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IHRoaXMucXVlcnkgPT09IG51bGwpIHtcbiAgICAvLyBudWxsIHF1ZXJ5IG1lYW5zIGNyZWF0ZVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgncGFzc3dvcmQnIGluIHRoaXMuZGF0YSB8fCAnZW1haWwnIGluIHRoaXMuZGF0YSkge1xuICAgIGNvbnN0IGFkZE9wcyA9IHtcbiAgICAgIF9wZXJpc2hhYmxlX3Rva2VuOiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgICBfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0OiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgfTtcbiAgICB0aGlzLmRhdGEgPSBPYmplY3QuYXNzaWduKHRoaXMuZGF0YSwgYWRkT3BzKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zID0gZnVuY3Rpb24oKSB7XG4gIC8vIE9ubHkgZm9yIF9TZXNzaW9uLCBhbmQgYXQgY3JlYXRpb24gdGltZVxuICBpZiAodGhpcy5jbGFzc05hbWUgIT0gJ19TZXNzaW9uJyB8fCB0aGlzLnF1ZXJ5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERlc3Ryb3kgdGhlIHNlc3Npb25zIGluICdCYWNrZ3JvdW5kJ1xuICBjb25zdCB7IHVzZXIsIGluc3RhbGxhdGlvbklkLCBzZXNzaW9uVG9rZW4gfSA9IHRoaXMuZGF0YTtcbiAgaWYgKCF1c2VyIHx8ICFpbnN0YWxsYXRpb25JZCkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXVzZXIub2JqZWN0SWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveShcbiAgICAnX1Nlc3Npb24nLFxuICAgIHtcbiAgICAgIHVzZXIsXG4gICAgICBpbnN0YWxsYXRpb25JZCxcbiAgICAgIHNlc3Npb25Ub2tlbjogeyAkbmU6IHNlc3Npb25Ub2tlbiB9LFxuICAgIH0sXG4gICAge30sXG4gICAgdGhpcy52YWxpZFNjaGVtYUNvbnRyb2xsZXJcbiAgKTtcbn07XG5cbi8vIEhhbmRsZXMgYW55IGZvbGxvd3VwIGxvZ2ljXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUZvbGxvd3VwID0gZnVuY3Rpb24oKSB7XG4gIGlmIChcbiAgICB0aGlzLnN0b3JhZ2UgJiZcbiAgICB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSAmJlxuICAgIHRoaXMuY29uZmlnLnJldm9rZVNlc3Npb25PblBhc3N3b3JkUmVzZXRcbiAgKSB7XG4gICAgdmFyIHNlc3Npb25RdWVyeSA9IHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBkZWxldGUgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ107XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuZGVzdHJveSgnX1Nlc3Npb24nLCBzZXNzaW9uUXVlcnkpXG4gICAgICAudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnZ2VuZXJhdGVOZXdTZXNzaW9uJ107XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuKCkudGhlbih0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcykpO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZSAmJiB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddKSB7XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnc2VuZFZlcmlmaWNhdGlvbkVtYWlsJ107XG4gICAgLy8gRmlyZSBhbmQgZm9yZ2V0IVxuICAgIHRoaXMuY29uZmlnLnVzZXJDb250cm9sbGVyLnNlbmRWZXJpZmljYXRpb25FbWFpbCh0aGlzLmRhdGEpO1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwLmJpbmQodGhpcyk7XG4gIH1cbn07XG5cbi8vIEhhbmRsZXMgdGhlIF9TZXNzaW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gX1Nlc3Npb24gb2JqZWN0LlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVTZXNzaW9uID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMuY2xhc3NOYW1lICE9PSAnX1Nlc3Npb24nKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGgudXNlciAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLFxuICAgICAgJ1Nlc3Npb24gdG9rZW4gcmVxdWlyZWQuJ1xuICAgICk7XG4gIH1cblxuICAvLyBUT0RPOiBWZXJpZnkgcHJvcGVyIGVycm9yIHRvIHRocm93XG4gIGlmICh0aGlzLmRhdGEuQUNMKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSxcbiAgICAgICdDYW5ub3Qgc2V0ICcgKyAnQUNMIG9uIGEgU2Vzc2lvbi4nXG4gICAgKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgaWYgKFxuICAgICAgdGhpcy5kYXRhLnVzZXIgJiZcbiAgICAgICF0aGlzLmF1dGguaXNNYXN0ZXIgJiZcbiAgICAgIHRoaXMuZGF0YS51c2VyLm9iamVjdElkICE9IHRoaXMuYXV0aC51c2VyLmlkXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuZGF0YS5zZXNzaW9uVG9rZW4pIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FKTtcbiAgICB9XG4gIH1cblxuICBpZiAoIXRoaXMucXVlcnkgJiYgIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIGNvbnN0IGFkZGl0aW9uYWxTZXNzaW9uRGF0YSA9IHt9O1xuICAgIGZvciAodmFyIGtleSBpbiB0aGlzLmRhdGEpIHtcbiAgICAgIGlmIChrZXkgPT09ICdvYmplY3RJZCcgfHwga2V5ID09PSAndXNlcicpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBhZGRpdGlvbmFsU2Vzc2lvbkRhdGFba2V5XSA9IHRoaXMuZGF0YVtrZXldO1xuICAgIH1cblxuICAgIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IEF1dGguY3JlYXRlU2Vzc2lvbih0aGlzLmNvbmZpZywge1xuICAgICAgdXNlcklkOiB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgIGNyZWF0ZWRXaXRoOiB7XG4gICAgICAgIGFjdGlvbjogJ2NyZWF0ZScsXG4gICAgICB9LFxuICAgICAgYWRkaXRpb25hbFNlc3Npb25EYXRhLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKCFyZXN1bHRzLnJlc3BvbnNlKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsXG4gICAgICAgICAgJ0Vycm9yIGNyZWF0aW5nIHNlc3Npb24uJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgc2Vzc2lvbkRhdGFbJ29iamVjdElkJ10gPSByZXN1bHRzLnJlc3BvbnNlWydvYmplY3RJZCddO1xuICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgc3RhdHVzOiAyMDEsXG4gICAgICAgIGxvY2F0aW9uOiByZXN1bHRzLmxvY2F0aW9uLFxuICAgICAgICByZXNwb25zZTogc2Vzc2lvbkRhdGEsXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfSW5zdGFsbGF0aW9uIGNsYXNzIHNwZWNpYWxuZXNzLlxuLy8gRG9lcyBub3RoaW5nIGlmIHRoaXMgaXNuJ3QgYW4gaW5zdGFsbGF0aW9uIG9iamVjdC5cbi8vIElmIGFuIGluc3RhbGxhdGlvbiBpcyBmb3VuZCwgdGhpcyBjYW4gbXV0YXRlIHRoaXMucXVlcnkgYW5kIHR1cm4gYSBjcmVhdGVcbi8vIGludG8gYW4gdXBkYXRlLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZW4gd2UncmUgZG9uZSBpZiBpdCBjYW4ndCBmaW5pc2ggdGhpcyB0aWNrLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVJbnN0YWxsYXRpb24gPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5jbGFzc05hbWUgIT09ICdfSW5zdGFsbGF0aW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChcbiAgICAhdGhpcy5xdWVyeSAmJlxuICAgICF0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiZcbiAgICAhdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgIXRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZFxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAxMzUsXG4gICAgICAnYXQgbGVhc3Qgb25lIElEIGZpZWxkIChkZXZpY2VUb2tlbiwgaW5zdGFsbGF0aW9uSWQpICcgK1xuICAgICAgICAnbXVzdCBiZSBzcGVjaWZpZWQgaW4gdGhpcyBvcGVyYXRpb24nXG4gICAgKTtcbiAgfVxuXG4gIC8vIElmIHRoZSBkZXZpY2UgdG9rZW4gaXMgNjQgY2hhcmFjdGVycyBsb25nLCB3ZSBhc3N1bWUgaXQgaXMgZm9yIGlPU1xuICAvLyBhbmQgbG93ZXJjYXNlIGl0LlxuICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuICYmIHRoaXMuZGF0YS5kZXZpY2VUb2tlbi5sZW5ndGggPT0gNjQpIHtcbiAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4udG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIC8vIFdlIGxvd2VyY2FzZSB0aGUgaW5zdGFsbGF0aW9uSWQgaWYgcHJlc2VudFxuICBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkID0gdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICBsZXQgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQ7XG5cbiAgLy8gSWYgZGF0YS5pbnN0YWxsYXRpb25JZCBpcyBub3Qgc2V0IGFuZCB3ZSdyZSBub3QgbWFzdGVyLCB3ZSBjYW4gbG9va3VwIGluIGF1dGhcbiAgaWYgKCFpbnN0YWxsYXRpb25JZCAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cblxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBpbnN0YWxsYXRpb25JZCA9IGluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBVcGRhdGluZyBfSW5zdGFsbGF0aW9uIGJ1dCBub3QgdXBkYXRpbmcgYW55dGhpbmcgY3JpdGljYWxcbiAgaWYgKFxuICAgIHRoaXMucXVlcnkgJiZcbiAgICAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgIWluc3RhbGxhdGlvbklkICYmXG4gICAgIXRoaXMuZGF0YS5kZXZpY2VUeXBlXG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbiAgdmFyIGlkTWF0Y2g7IC8vIFdpbGwgYmUgYSBtYXRjaCBvbiBlaXRoZXIgb2JqZWN0SWQgb3IgaW5zdGFsbGF0aW9uSWRcbiAgdmFyIG9iamVjdElkTWF0Y2g7XG4gIHZhciBpbnN0YWxsYXRpb25JZE1hdGNoO1xuICB2YXIgZGV2aWNlVG9rZW5NYXRjaGVzID0gW107XG5cbiAgLy8gSW5zdGVhZCBvZiBpc3N1aW5nIDMgcmVhZHMsIGxldCdzIGRvIGl0IHdpdGggb25lIE9SLlxuICBjb25zdCBvclF1ZXJpZXMgPSBbXTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIG9yUXVlcmllcy5wdXNoKHtcbiAgICAgIG9iamVjdElkOiB0aGlzLnF1ZXJ5Lm9iamVjdElkLFxuICAgIH0pO1xuICB9XG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIG9yUXVlcmllcy5wdXNoKHtcbiAgICAgIGluc3RhbGxhdGlvbklkOiBpbnN0YWxsYXRpb25JZCxcbiAgICB9KTtcbiAgfVxuICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goeyBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuIH0pO1xuICB9XG5cbiAgaWYgKG9yUXVlcmllcy5sZW5ndGggPT0gMCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHByb21pc2UgPSBwcm9taXNlXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAgICdfSW5zdGFsbGF0aW9uJyxcbiAgICAgICAge1xuICAgICAgICAgICRvcjogb3JRdWVyaWVzLFxuICAgICAgICB9LFxuICAgICAgICB7fVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgcmVzdWx0cy5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0aGlzLnF1ZXJ5ICYmXG4gICAgICAgICAgdGhpcy5xdWVyeS5vYmplY3RJZCAmJlxuICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9PSB0aGlzLnF1ZXJ5Lm9iamVjdElkXG4gICAgICAgICkge1xuICAgICAgICAgIG9iamVjdElkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5pbnN0YWxsYXRpb25JZCA9PSBpbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIGluc3RhbGxhdGlvbklkTWF0Y2ggPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5kZXZpY2VUb2tlbiA9PSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgLy8gU2FuaXR5IGNoZWNrcyB3aGVuIHJ1bm5pbmcgYSBxdWVyeVxuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICBpZiAoIW9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgICAgJ09iamVjdCBub3QgZm91bmQgZm9yIHVwZGF0ZS4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAhPT0gb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAxMzYsXG4gICAgICAgICAgICAnaW5zdGFsbGF0aW9uSWQgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgICAgICAgb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAhPT0gb2JqZWN0SWRNYXRjaC5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgICF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICAhb2JqZWN0SWRNYXRjaC5pbnN0YWxsYXRpb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAxMzYsXG4gICAgICAgICAgICAnZGV2aWNlVG9rZW4gbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJlxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICE9PSBvYmplY3RJZE1hdGNoLmRldmljZVR5cGVcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgMTM2LFxuICAgICAgICAgICAgJ2RldmljZVR5cGUgbWF5IG5vdCBiZSBjaGFuZ2VkIGluIHRoaXMgJyArICdvcGVyYXRpb24nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIG9iamVjdElkTWF0Y2gpIHtcbiAgICAgICAgaWRNYXRjaCA9IG9iamVjdElkTWF0Y2g7XG4gICAgICB9XG5cbiAgICAgIGlmIChpbnN0YWxsYXRpb25JZCAmJiBpbnN0YWxsYXRpb25JZE1hdGNoKSB7XG4gICAgICAgIGlkTWF0Y2ggPSBpbnN0YWxsYXRpb25JZE1hdGNoO1xuICAgICAgfVxuICAgICAgLy8gbmVlZCB0byBzcGVjaWZ5IGRldmljZVR5cGUgb25seSBpZiBpdCdzIG5ld1xuICAgICAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuZGV2aWNlVHlwZSAmJiAhaWRNYXRjaCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgMTM1LFxuICAgICAgICAgICdkZXZpY2VUeXBlIG11c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgaWYgKCFpZE1hdGNoKSB7XG4gICAgICAgIGlmICghZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICBkZXZpY2VUb2tlbk1hdGNoZXMubGVuZ3RoID09IDEgJiZcbiAgICAgICAgICAoIWRldmljZVRva2VuTWF0Y2hlc1swXVsnaW5zdGFsbGF0aW9uSWQnXSB8fCAhaW5zdGFsbGF0aW9uSWQpXG4gICAgICAgICkge1xuICAgICAgICAgIC8vIFNpbmdsZSBtYXRjaCBvbiBkZXZpY2UgdG9rZW4gYnV0IG5vbmUgb24gaW5zdGFsbGF0aW9uSWQsIGFuZCBlaXRoZXJcbiAgICAgICAgICAvLyB0aGUgcGFzc2VkIG9iamVjdCBvciB0aGUgbWF0Y2ggaXMgbWlzc2luZyBhbiBpbnN0YWxsYXRpb25JZCwgc28gd2VcbiAgICAgICAgICAvLyBjYW4ganVzdCByZXR1cm4gdGhlIG1hdGNoLlxuICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgIH0gZWxzZSBpZiAoIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIDEzMixcbiAgICAgICAgICAgICdNdXN0IHNwZWNpZnkgaW5zdGFsbGF0aW9uSWQgd2hlbiBkZXZpY2VUb2tlbiAnICtcbiAgICAgICAgICAgICAgJ21hdGNoZXMgbXVsdGlwbGUgSW5zdGFsbGF0aW9uIG9iamVjdHMnXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBNdWx0aXBsZSBkZXZpY2UgdG9rZW4gbWF0Y2hlcyBhbmQgd2Ugc3BlY2lmaWVkIGFuIGluc3RhbGxhdGlvbiBJRCxcbiAgICAgICAgICAvLyBvciBhIHNpbmdsZSBtYXRjaCB3aGVyZSBib3RoIHRoZSBwYXNzZWQgYW5kIG1hdGNoaW5nIG9iamVjdHMgaGF2ZVxuICAgICAgICAgIC8vIGFuIGluc3RhbGxhdGlvbiBJRC4gVHJ5IGNsZWFuaW5nIG91dCBvbGQgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoXG4gICAgICAgICAgLy8gdGhlIGRldmljZVRva2VuLCBhbmQgcmV0dXJuIG5pbCB0byBzaWduYWwgdGhhdCBhIG5ldyBvYmplY3Qgc2hvdWxkXG4gICAgICAgICAgLy8gYmUgY3JlYXRlZC5cbiAgICAgICAgICB2YXIgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHtcbiAgICAgICAgICAgICAgJG5lOiBpbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfTtcbiAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KS5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgaWYgKGVyci5jb2RlID09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgLy8gbm8gZGVsZXRpb25zIHdlcmUgbWFkZS4gQ2FuIGJlIGlnbm9yZWQuXG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIHJldGhyb3cgdGhlIGVycm9yXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmXG4gICAgICAgICAgIWRldmljZVRva2VuTWF0Y2hlc1swXVsnaW5zdGFsbGF0aW9uSWQnXVxuICAgICAgICApIHtcbiAgICAgICAgICAvLyBFeGFjdGx5IG9uZSBkZXZpY2UgdG9rZW4gbWF0Y2ggYW5kIGl0IGRvZXNuJ3QgaGF2ZSBhbiBpbnN0YWxsYXRpb25cbiAgICAgICAgICAvLyBJRC4gVGhpcyBpcyB0aGUgb25lIGNhc2Ugd2hlcmUgd2Ugd2FudCB0byBtZXJnZSB3aXRoIHRoZSBleGlzdGluZ1xuICAgICAgICAgIC8vIG9iamVjdC5cbiAgICAgICAgICBjb25zdCBkZWxRdWVyeSA9IHsgb2JqZWN0SWQ6IGlkTWF0Y2gub2JqZWN0SWQgfTtcbiAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAgIC5kZXN0cm95KCdfSW5zdGFsbGF0aW9uJywgZGVsUXVlcnkpXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIHJldHVybiBkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ29iamVjdElkJ107XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgICAgLy8gbm8gZGVsZXRpb25zIHdlcmUgbWFkZS4gQ2FuIGJlIGlnbm9yZWRcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgLy8gcmV0aHJvdyB0aGUgZXJyb3JcbiAgICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgICAgICAgICBpZE1hdGNoLmRldmljZVRva2VuICE9IHRoaXMuZGF0YS5kZXZpY2VUb2tlblxuICAgICAgICAgICkge1xuICAgICAgICAgICAgLy8gV2UncmUgc2V0dGluZyB0aGUgZGV2aWNlIHRva2VuIG9uIGFuIGV4aXN0aW5nIGluc3RhbGxhdGlvbiwgc29cbiAgICAgICAgICAgIC8vIHdlIHNob3VsZCB0cnkgY2xlYW5pbmcgb3V0IG9sZCBpbnN0YWxsYXRpb25zIHRoYXQgbWF0Y2ggdGhpc1xuICAgICAgICAgICAgLy8gZGV2aWNlIHRva2VuLlxuICAgICAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7XG4gICAgICAgICAgICAgIGRldmljZVRva2VuOiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgLy8gV2UgaGF2ZSBhIHVuaXF1ZSBpbnN0YWxsIElkLCB1c2UgdGhhdCB0byBwcmVzZXJ2ZVxuICAgICAgICAgICAgLy8gdGhlIGludGVyZXN0aW5nIGluc3RhbGxhdGlvblxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgICAgICAgICBkZWxRdWVyeVsnaW5zdGFsbGF0aW9uSWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgJiZcbiAgICAgICAgICAgICAgdGhpcy5kYXRhLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIGlkTWF0Y2gub2JqZWN0SWQgPT0gdGhpcy5kYXRhLm9iamVjdElkXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gd2UgcGFzc2VkIGFuIG9iamVjdElkLCBwcmVzZXJ2ZSB0aGF0IGluc3RhbGF0aW9uXG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydvYmplY3RJZCddID0ge1xuICAgICAgICAgICAgICAgICRuZTogaWRNYXRjaC5vYmplY3RJZCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIFdoYXQgdG8gZG8gaGVyZT8gY2FuJ3QgcmVhbGx5IGNsZWFuIHVwIGV2ZXJ5dGhpbmcuLi5cbiAgICAgICAgICAgICAgcmV0dXJuIGlkTWF0Y2gub2JqZWN0SWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodGhpcy5kYXRhLmFwcElkZW50aWZpZXIpIHtcbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ2FwcElkZW50aWZpZXInXSA9IHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgICAgICAgLmRlc3Ryb3koJ19JbnN0YWxsYXRpb24nLCBkZWxRdWVyeSlcbiAgICAgICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGVyci5jb2RlID09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkLlxuICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAvLyByZXRocm93IHRoZSBlcnJvclxuICAgICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEluIG5vbi1tZXJnZSBzY2VuYXJpb3MsIGp1c3QgcmV0dXJuIHRoZSBpbnN0YWxsYXRpb24gbWF0Y2ggaWRcbiAgICAgICAgICByZXR1cm4gaWRNYXRjaC5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4ob2JqSWQgPT4ge1xuICAgICAgaWYgKG9iaklkKSB7XG4gICAgICAgIHRoaXMucXVlcnkgPSB7IG9iamVjdElkOiBvYmpJZCB9O1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcbiAgICAgIH1cbiAgICAgIC8vIFRPRE86IFZhbGlkYXRlIG9wcyAoYWRkL3JlbW92ZSBvbiBjaGFubmVscywgJGluYyBvbiBiYWRnZSwgZXRjLilcbiAgICB9KTtcbiAgcmV0dXJuIHByb21pc2U7XG59O1xuXG4vLyBJZiB3ZSBzaG9ydC1jaXJjdXRlZCB0aGUgb2JqZWN0IHJlc3BvbnNlIC0gdGhlbiB3ZSBuZWVkIHRvIG1ha2Ugc3VyZSB3ZSBleHBhbmQgYWxsIHRoZSBmaWxlcyxcbi8vIHNpbmNlIHRoaXMgbWlnaHQgbm90IGhhdmUgYSBxdWVyeSwgbWVhbmluZyBpdCB3b24ndCByZXR1cm4gdGhlIGZ1bGwgcmVzdWx0IGJhY2suXG4vLyBUT0RPOiAobmx1dHNlbmtvKSBUaGlzIHNob3VsZCBkaWUgd2hlbiB3ZSBtb3ZlIHRvIHBlci1jbGFzcyBiYXNlZCBjb250cm9sbGVycyBvbiBfU2Vzc2lvbi9fVXNlclxuUmVzdFdyaXRlLnByb3RvdHlwZS5leHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyA9IGZ1bmN0aW9uKCkge1xuICAvLyBDaGVjayB3aGV0aGVyIHdlIGhhdmUgYSBzaG9ydC1jaXJjdWl0ZWQgcmVzcG9uc2UgLSBvbmx5IHRoZW4gcnVuIGV4cGFuc2lvbi5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlXG4gICAgKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5EYXRhYmFzZU9wZXJhdGlvbiA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Sb2xlJykge1xuICAgIHRoaXMuY29uZmlnLmNhY2hlQ29udHJvbGxlci5yb2xlLmNsZWFyKCk7XG4gIH1cblxuICBpZiAoXG4gICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICB0aGlzLnF1ZXJ5ICYmXG4gICAgdGhpcy5hdXRoLmlzVW5hdXRoZW50aWNhdGVkKClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuU0VTU0lPTl9NSVNTSU5HLFxuICAgICAgYENhbm5vdCBtb2RpZnkgdXNlciAke3RoaXMucXVlcnkub2JqZWN0SWR9LmBcbiAgICApO1xuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1Byb2R1Y3QnICYmIHRoaXMuZGF0YS5kb3dubG9hZCkge1xuICAgIHRoaXMuZGF0YS5kb3dubG9hZE5hbWUgPSB0aGlzLmRhdGEuZG93bmxvYWQubmFtZTtcbiAgfVxuXG4gIC8vIFRPRE86IEFkZCBiZXR0ZXIgZGV0ZWN0aW9uIGZvciBBQ0wsIGVuc3VyaW5nIGEgdXNlciBjYW4ndCBiZSBsb2NrZWQgZnJvbVxuICAvLyAgICAgICB0aGVpciBvd24gdXNlciByZWNvcmQuXG4gIGlmICh0aGlzLmRhdGEuQUNMICYmIHRoaXMuZGF0YS5BQ0xbJyp1bnJlc29sdmVkJ10pIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9BQ0wsICdJbnZhbGlkIEFDTC4nKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgLy8gRm9yY2UgdGhlIHVzZXIgdG8gbm90IGxvY2tvdXRcbiAgICAvLyBNYXRjaGVkIHdpdGggcGFyc2UuY29tXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5BQ0wgJiZcbiAgICAgIHRoaXMuYXV0aC5pc01hc3RlciAhPT0gdHJ1ZVxuICAgICkge1xuICAgICAgdGhpcy5kYXRhLkFDTFt0aGlzLnF1ZXJ5Lm9iamVjdElkXSA9IHsgcmVhZDogdHJ1ZSwgd3JpdGU6IHRydWUgfTtcbiAgICB9XG4gICAgLy8gdXBkYXRlIHBhc3N3b3JkIHRpbWVzdGFtcCBpZiB1c2VyIHBhc3N3b3JkIGlzIGJlaW5nIGNoYW5nZWRcbiAgICBpZiAoXG4gICAgICB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICAgdGhpcy5kYXRhLl9oYXNoZWRfcGFzc3dvcmQgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZVxuICAgICkge1xuICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICB9XG4gICAgLy8gSWdub3JlIGNyZWF0ZWRBdCB3aGVuIHVwZGF0ZVxuICAgIGRlbGV0ZSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgbGV0IGRlZmVyID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgLy8gaWYgcGFzc3dvcmQgaGlzdG9yeSBpcyBlbmFibGVkIHRoZW4gc2F2ZSB0aGUgY3VycmVudCBwYXNzd29yZCB0byBoaXN0b3J5XG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5XG4gICAgKSB7XG4gICAgICBkZWZlciA9IHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgIC5maW5kKFxuICAgICAgICAgICdfVXNlcicsXG4gICAgICAgICAgeyBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgICAgeyBrZXlzOiBbJ19wYXNzd29yZF9oaXN0b3J5JywgJ19oYXNoZWRfcGFzc3dvcmQnXSB9XG4gICAgICAgIClcbiAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICAgIHRocm93IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgICAgbGV0IG9sZFBhc3N3b3JkcyA9IFtdO1xuICAgICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KSB7XG4gICAgICAgICAgICBvbGRQYXNzd29yZHMgPSBfLnRha2UoXG4gICAgICAgICAgICAgIHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksXG4gICAgICAgICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy9uLTEgcGFzc3dvcmRzIGdvIGludG8gaGlzdG9yeSBpbmNsdWRpbmcgbGFzdCBwYXNzd29yZFxuICAgICAgICAgIHdoaWxlIChcbiAgICAgICAgICAgIG9sZFBhc3N3b3Jkcy5sZW5ndGggPlxuICAgICAgICAgICAgTWF0aC5tYXgoMCwgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5IC0gMilcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIG9sZFBhc3N3b3Jkcy5zaGlmdCgpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvbGRQYXNzd29yZHMucHVzaCh1c2VyLnBhc3N3b3JkKTtcbiAgICAgICAgICB0aGlzLmRhdGEuX3Bhc3N3b3JkX2hpc3RvcnkgPSBvbGRQYXNzd29yZHM7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBkZWZlci50aGVuKCgpID0+IHtcbiAgICAgIC8vIFJ1biBhbiB1cGRhdGVcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAudXBkYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICAgICAgICApXG4gICAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICByZXNwb25zZS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICAgICAgICB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKHJlc3BvbnNlLCB0aGlzLmRhdGEpO1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UgPSB7IHJlc3BvbnNlIH07XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIC8vIFNldCB0aGUgZGVmYXVsdCBBQ0wgYW5kIHBhc3N3b3JkIHRpbWVzdGFtcCBmb3IgdGhlIG5ldyBfVXNlclxuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgICAgdmFyIEFDTCA9IHRoaXMuZGF0YS5BQ0w7XG4gICAgICAvLyBkZWZhdWx0IHB1YmxpYyByL3cgQUNMXG4gICAgICBpZiAoIUFDTCkge1xuICAgICAgICBBQ0wgPSB7fTtcbiAgICAgICAgQUNMWycqJ10gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiBmYWxzZSB9O1xuICAgICAgfVxuICAgICAgLy8gbWFrZSBzdXJlIHRoZSB1c2VyIGlzIG5vdCBsb2NrZWQgZG93blxuICAgICAgQUNMW3RoaXMuZGF0YS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgICB0aGlzLmRhdGEuQUNMID0gQUNMO1xuICAgICAgLy8gcGFzc3dvcmQgdGltZXN0YW1wIHRvIGJlIHVzZWQgd2hlbiBwYXNzd29yZCBleHBpcnkgcG9saWN5IGlzIGVuZm9yY2VkXG4gICAgICBpZiAoXG4gICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmXG4gICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlXG4gICAgICApIHtcbiAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSdW4gYSBjcmVhdGVcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5jcmVhdGUoXG4gICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICB0aGlzLmRhdGEsXG4gICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgZmFsc2UsXG4gICAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicgfHxcbiAgICAgICAgICBlcnJvci5jb2RlICE9PSBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUVcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBRdWljayBjaGVjaywgaWYgd2Ugd2VyZSBhYmxlIHRvIGluZmVyIHRoZSBkdXBsaWNhdGVkIGZpZWxkIG5hbWVcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGVycm9yICYmXG4gICAgICAgICAgZXJyb3IudXNlckluZm8gJiZcbiAgICAgICAgICBlcnJvci51c2VySW5mby5kdXBsaWNhdGVkX2ZpZWxkID09PSAndXNlcm5hbWUnXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLlVTRVJOQU1FX1RBS0VOLFxuICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXG4gICAgICAgICAgZXJyb3IgJiZcbiAgICAgICAgICBlcnJvci51c2VySW5mbyAmJlxuICAgICAgICAgIGVycm9yLnVzZXJJbmZvLmR1cGxpY2F0ZWRfZmllbGQgPT09ICdlbWFpbCdcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgdGhpcyB3YXMgYSBmYWlsZWQgdXNlciBjcmVhdGlvbiBkdWUgdG8gdXNlcm5hbWUgb3IgZW1haWwgYWxyZWFkeSB0YWtlbiwgd2UgbmVlZCB0b1xuICAgICAgICAvLyBjaGVjayB3aGV0aGVyIGl0IHdhcyB1c2VybmFtZSBvciBlbWFpbCBhbmQgcmV0dXJuIHRoZSBhcHByb3ByaWF0ZSBlcnJvci5cbiAgICAgICAgLy8gRmFsbGJhY2sgdG8gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgICAgICAvLyBUT0RPOiBTZWUgaWYgd2UgY2FuIGxhdGVyIGRvIHRoaXMgd2l0aG91dCBhZGRpdGlvbmFsIHF1ZXJpZXMgYnkgdXNpbmcgbmFtZWQgaW5kZXhlcy5cbiAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgICAgLmZpbmQoXG4gICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSxcbiAgICAgICAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7IGxpbWl0OiAxIH1cbiAgICAgICAgICApXG4gICAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICAgIHsgZW1haWw6IHRoaXMuZGF0YS5lbWFpbCwgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSB9LFxuICAgICAgICAgICAgICB7IGxpbWl0OiAxIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgIHJlc3BvbnNlLm9iamVjdElkID0gdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICByZXNwb25zZS5jcmVhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgICAgIGlmICh0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lKSB7XG4gICAgICAgICAgcmVzcG9uc2UudXNlcm5hbWUgPSB0aGlzLmRhdGEudXNlcm5hbWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShyZXNwb25zZSwgdGhpcy5kYXRhKTtcbiAgICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgICBzdGF0dXM6IDIwMSxcbiAgICAgICAgICByZXNwb25zZSxcbiAgICAgICAgICBsb2NhdGlvbjogdGhpcy5sb2NhdGlvbigpLFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gIH1cbn07XG5cbi8vIFJldHVybnMgbm90aGluZyAtIGRvZXNuJ3Qgd2FpdCBmb3IgdGhlIHRyaWdnZXIuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkFmdGVyU2F2ZVRyaWdnZXIgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLnJlc3BvbnNlIHx8ICF0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYWZ0ZXJTYXZlJyB0cmlnZ2VyIGZvciB0aGlzIGNsYXNzLlxuICBjb25zdCBoYXNBZnRlclNhdmVIb29rID0gdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICApO1xuICBjb25zdCBoYXNMaXZlUXVlcnkgPSB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLmhhc0xpdmVRdWVyeShcbiAgICB0aGlzLmNsYXNzTmFtZVxuICApO1xuICBpZiAoIWhhc0FmdGVyU2F2ZUhvb2sgJiYgIWhhc0xpdmVRdWVyeSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHZhciBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUgfTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIGV4dHJhRGF0YS5vYmplY3RJZCA9IHRoaXMucXVlcnkub2JqZWN0SWQ7XG4gIH1cblxuICAvLyBCdWlsZCB0aGUgb3JpZ2luYWwgb2JqZWN0LCB3ZSBvbmx5IGRvIHRoaXMgZm9yIGEgdXBkYXRlIHdyaXRlLlxuICBsZXQgb3JpZ2luYWxPYmplY3Q7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvcmlnaW5hbE9iamVjdCA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIH1cblxuICAvLyBCdWlsZCB0aGUgaW5mbGF0ZWQgb2JqZWN0LCBkaWZmZXJlbnQgZnJvbSBiZWZvcmVTYXZlLCBvcmlnaW5hbERhdGEgaXMgbm90IGVtcHR5XG4gIC8vIHNpbmNlIGRldmVsb3BlcnMgY2FuIGNoYW5nZSBkYXRhIGluIHRoZSBiZWZvcmVTYXZlLlxuICBjb25zdCB1cGRhdGVkT2JqZWN0ID0gdGhpcy5idWlsZFVwZGF0ZWRPYmplY3QoZXh0cmFEYXRhKTtcbiAgdXBkYXRlZE9iamVjdC5faGFuZGxlU2F2ZVJlc3BvbnNlKFxuICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UsXG4gICAgdGhpcy5yZXNwb25zZS5zdGF0dXMgfHwgMjAwXG4gICk7XG5cbiAgdGhpcy5jb25maWcuZGF0YWJhc2UubG9hZFNjaGVtYSgpLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgLy8gTm90aWZpeSBMaXZlUXVlcnlTZXJ2ZXIgaWYgcG9zc2libGVcbiAgICBjb25zdCBwZXJtcyA9IHNjaGVtYUNvbnRyb2xsZXIuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKFxuICAgICAgdXBkYXRlZE9iamVjdC5jbGFzc05hbWVcbiAgICApO1xuICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIub25BZnRlclNhdmUoXG4gICAgICB1cGRhdGVkT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgIHVwZGF0ZWRPYmplY3QsXG4gICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgIHBlcm1zXG4gICAgKTtcbiAgfSk7XG5cbiAgLy8gUnVuIGFmdGVyU2F2ZSB0cmlnZ2VyXG4gIHJldHVybiB0cmlnZ2Vyc1xuICAgIC5tYXliZVJ1blRyaWdnZXIoXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlclNhdmUsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgb3JpZ2luYWxPYmplY3QsXG4gICAgICB0aGlzLmNvbmZpZyxcbiAgICAgIHRoaXMuY29udGV4dFxuICAgIClcbiAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgaWYgKHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlID0gcmVzdWx0O1xuICAgICAgfVxuICAgIH0pXG4gICAgLmNhdGNoKGZ1bmN0aW9uKGVycikge1xuICAgICAgbG9nZ2VyLndhcm4oJ2FmdGVyU2F2ZSBjYXVnaHQgYW4gZXJyb3InLCBlcnIpO1xuICAgIH0pO1xufTtcblxuLy8gQSBoZWxwZXIgdG8gZmlndXJlIG91dCB3aGF0IGxvY2F0aW9uIHRoaXMgb3BlcmF0aW9uIGhhcHBlbnMgYXQuXG5SZXN0V3JpdGUucHJvdG90eXBlLmxvY2F0aW9uID0gZnVuY3Rpb24oKSB7XG4gIHZhciBtaWRkbGUgPVxuICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInID8gJy91c2Vycy8nIDogJy9jbGFzc2VzLycgKyB0aGlzLmNsYXNzTmFtZSArICcvJztcbiAgcmV0dXJuIHRoaXMuY29uZmlnLm1vdW50ICsgbWlkZGxlICsgdGhpcy5kYXRhLm9iamVjdElkO1xufTtcblxuLy8gQSBoZWxwZXIgdG8gZ2V0IHRoZSBvYmplY3QgaWQgZm9yIHRoaXMgb3BlcmF0aW9uLlxuLy8gQmVjYXVzZSBpdCBjb3VsZCBiZSBlaXRoZXIgb24gdGhlIHF1ZXJ5IG9yIG9uIHRoZSBkYXRhXG5SZXN0V3JpdGUucHJvdG90eXBlLm9iamVjdElkID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLmRhdGEub2JqZWN0SWQgfHwgdGhpcy5xdWVyeS5vYmplY3RJZDtcbn07XG5cbi8vIFJldHVybnMgYSBjb3B5IG9mIHRoZSBkYXRhIGFuZCBkZWxldGUgYmFkIGtleXMgKF9hdXRoX2RhdGEsIF9oYXNoZWRfcGFzc3dvcmQuLi4pXG5SZXN0V3JpdGUucHJvdG90eXBlLnNhbml0aXplZERhdGEgPSBmdW5jdGlvbigpIHtcbiAgY29uc3QgZGF0YSA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YSkucmVkdWNlKChkYXRhLCBrZXkpID0+IHtcbiAgICAvLyBSZWdleHAgY29tZXMgZnJvbSBQYXJzZS5PYmplY3QucHJvdG90eXBlLnZhbGlkYXRlXG4gICAgaWYgKCEvXltBLVphLXpdWzAtOUEtWmEtel9dKiQvLnRlc3Qoa2V5KSkge1xuICAgICAgZGVsZXRlIGRhdGFba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIGRhdGE7XG4gIH0sIGRlZXBjb3B5KHRoaXMuZGF0YSkpO1xuICByZXR1cm4gUGFyc2UuX2RlY29kZSh1bmRlZmluZWQsIGRhdGEpO1xufTtcblxuLy8gUmV0dXJucyBhbiB1cGRhdGVkIGNvcHkgb2YgdGhlIG9iamVjdFxuUmVzdFdyaXRlLnByb3RvdHlwZS5idWlsZFVwZGF0ZWRPYmplY3QgPSBmdW5jdGlvbihleHRyYURhdGEpIHtcbiAgY29uc3QgdXBkYXRlZE9iamVjdCA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIE9iamVjdC5rZXlzKHRoaXMuZGF0YSkucmVkdWNlKGZ1bmN0aW9uKGRhdGEsIGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgLy8gc3ViZG9jdW1lbnQga2V5IHdpdGggZG90IG5vdGF0aW9uICgneC55Jzp2ID0+ICd4Jzp7J3knOnZ9KVxuICAgICAgY29uc3Qgc3BsaXR0ZWRLZXkgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgIGNvbnN0IHBhcmVudFByb3AgPSBzcGxpdHRlZEtleVswXTtcbiAgICAgIGxldCBwYXJlbnRWYWwgPSB1cGRhdGVkT2JqZWN0LmdldChwYXJlbnRQcm9wKTtcbiAgICAgIGlmICh0eXBlb2YgcGFyZW50VmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICBwYXJlbnRWYWwgPSB7fTtcbiAgICAgIH1cbiAgICAgIHBhcmVudFZhbFtzcGxpdHRlZEtleVsxXV0gPSBkYXRhW2tleV07XG4gICAgICB1cGRhdGVkT2JqZWN0LnNldChwYXJlbnRQcm9wLCBwYXJlbnRWYWwpO1xuICAgICAgZGVsZXRlIGRhdGFba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIGRhdGE7XG4gIH0sIGRlZXBjb3B5KHRoaXMuZGF0YSkpO1xuXG4gIHVwZGF0ZWRPYmplY3Quc2V0KHRoaXMuc2FuaXRpemVkRGF0YSgpKTtcbiAgcmV0dXJuIHVwZGF0ZWRPYmplY3Q7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNsZWFuVXNlckF1dGhEYXRhID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICBjb25zdCB1c2VyID0gdGhpcy5yZXNwb25zZS5yZXNwb25zZTtcbiAgICBpZiAodXNlci5hdXRoRGF0YSkge1xuICAgICAgT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgIGlmICh1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBpZiAoT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkubGVuZ3RoID09IDApIHtcbiAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGE7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhID0gZnVuY3Rpb24ocmVzcG9uc2UsIGRhdGEpIHtcbiAgaWYgKF8uaXNFbXB0eSh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlcikpIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgY2xpZW50U3VwcG9ydHNEZWxldGUgPSBDbGllbnRTREsuc3VwcG9ydHNGb3J3YXJkRGVsZXRlKHRoaXMuY2xpZW50U0RLKTtcbiAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGNvbnN0IGRhdGFWYWx1ZSA9IGRhdGFbZmllbGROYW1lXTtcblxuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3BvbnNlLCBmaWVsZE5hbWUpKSB7XG4gICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgIH1cblxuICAgIC8vIFN0cmlwcyBvcGVyYXRpb25zIGZyb20gcmVzcG9uc2VzXG4gICAgaWYgKHJlc3BvbnNlW2ZpZWxkTmFtZV0gJiYgcmVzcG9uc2VbZmllbGROYW1lXS5fX29wKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2VbZmllbGROYW1lXTtcbiAgICAgIGlmIChjbGllbnRTdXBwb3J0c0RlbGV0ZSAmJiBkYXRhVmFsdWUuX19vcCA9PSAnRGVsZXRlJykge1xuICAgICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiByZXNwb25zZTtcbn07XG5cbmZ1bmN0aW9uIHRyYWNlUHJvbWlzZShvcGVyYXRpb24sIGNsYXNzTmFtZSwgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpKSB7XG4gIGNvbnN0IHBhcmVudCA9IEFXU1hSYXkuZ2V0U2VnbWVudCgpO1xuICBpZiAoIXBhcmVudCkge1xuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgQVdTWFJheS5jYXB0dXJlQXN5bmNGdW5jKFxuICAgICAgYFBhcnNlLVNlcnZlcl9SZXN0V3JpdGVfJHtvcGVyYXRpb259XyR7Y2xhc3NOYW1lfWAsXG4gICAgICBzdWJzZWdtZW50ID0+IHtcbiAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ0NvbnRyb2xsZXInLCAnUmVzdFdyaXRlJyk7XG4gICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdPcGVyYXRpb24nLCBvcGVyYXRpb24pO1xuICAgICAgICBjbGFzc05hbWUgJiBzdWJzZWdtZW50ICYmXG4gICAgICAgICAgc3Vic2VnbWVudC5hZGRBbm5vdGF0aW9uKCdDbGFzc05hbWUnLCBjbGFzc05hbWUpO1xuICAgICAgICAocHJvbWlzZSBpbnN0YW5jZW9mIFByb21pc2UgPyBwcm9taXNlIDogUHJvbWlzZS5yZXNvbHZlKHByb21pc2UpKS50aGVuKFxuICAgICAgICAgIGZ1bmN0aW9uKHJlc3VsdCkge1xuICAgICAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xuICAgICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBmdW5jdGlvbihlcnJvcikge1xuICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgICAgICAgIHN1YnNlZ21lbnQgJiYgc3Vic2VnbWVudC5jbG9zZShlcnJvcik7XG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgfVxuICAgICk7XG4gIH0pO1xufVxuXG5leHBvcnQgZGVmYXVsdCBSZXN0V3JpdGU7XG5tb2R1bGUuZXhwb3J0cyA9IFJlc3RXcml0ZTtcbiJdfQ==