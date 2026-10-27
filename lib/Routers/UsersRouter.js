"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.UsersRouter = void 0;
var _node = _interopRequireDefault(require("parse/node"));
var _Config = _interopRequireDefault(require("../Config"));
var _AccountLockout = _interopRequireDefault(require("../AccountLockout"));
var _ClassesRouter = _interopRequireDefault(require("./ClassesRouter"));
var _rest = _interopRequireDefault(require("../rest"));
var _Auth = _interopRequireDefault(require("../Auth"));
var _password = _interopRequireDefault(require("../password"));
var _triggers = require("../triggers");
var _middlewares = require("../middlewares");
var _RestWrite = _interopRequireDefault(require("../RestWrite"));
var _logger = require("../logger");
var _Error = require("../Error");
var _AuthDataLock = require("../AuthDataLock");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// These methods handle the User-related routes.

class UsersRouter extends _ClassesRouter.default {
  className() {
    return '_User';
  }

  /**
   * Removes all "_" prefixed properties from an object, except "__type"
   * @param {Object} obj An object.
   */
  static removeHiddenProperties(obj) {
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        // Regexp comes from Parse.Object.prototype.validate
        if (key !== '__type' && !/^[A-Za-z][0-9A-Za-z_]*$/.test(key)) {
          delete obj[key];
        }
      }
    }
  }

  /**
   * After retrieving a user directly from the database, we need to remove the
   * password from the object (for security), and fix an issue some SDKs have
   * with null values
   */
  _sanitizeAuthData(user) {
    delete user.password;

    // Sometimes the authData still has null on that keys
    // https://github.com/parse-community/parse-server/issues/935
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

  /**
   * Validates a password request in login and verifyPassword
   * @param {Object} req The request
   * @returns {Object} User object
   * @private
   */
  _authenticateUserFromRequest(req) {
    return new Promise((resolve, reject) => {
      // Use query parameters instead if provided in url
      let payload = req.body || {};
      if (!payload.username && req.query && req.query.username || !payload.email && req.query && req.query.email) {
        payload = req.query;
      }
      const {
        username,
        email,
        password,
        ignoreEmailVerification
      } = payload;

      // TODO: use the right error codes / descriptions.
      if (!username && !email) {
        throw new _node.default.Error(_node.default.Error.USERNAME_MISSING, 'username/email is required.');
      }
      if (!password) {
        throw new _node.default.Error(_node.default.Error.PASSWORD_MISSING, 'password is required.');
      }
      if (typeof password !== 'string' || email && typeof email !== 'string' || username && typeof username !== 'string') {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Invalid username/password.');
      }
      let user;
      let isValidPassword = false;
      let query;
      if (email && username) {
        query = {
          email,
          username
        };
      } else if (email) {
        query = {
          email
        };
      } else {
        query = {
          $or: [{
            username
          }, {
            email: username
          }]
        };
      }
      return req.config.database.find('_User', query, {}, _Auth.default.maintenance(req.config)).then(results => {
        if (!results.length) {
          // Perform a dummy bcrypt compare to normalize response timing,
          // preventing user enumeration via timing side-channel
          return _password.default.compare(password, _password.default.dummyHash).then(() => {
            throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Invalid username/password.');
          });
        }
        if (results.length > 1) {
          // corner case where user1 has username == user2 email
          req.config.loggerController.warn("There is a user which email is the same as another user's username, logging in based on username");
          user = results.filter(user => user.username === username)[0];
        } else {
          user = results[0];
        }
        if (typeof user.password !== 'string' || user.password.length === 0) {
          // Passwordless account (e.g. OAuth-only): run dummy compare for
          // timing normalization, discard result, always reject
          return _password.default.compare(password, _password.default.dummyHash).then(() => false);
        }
        return _password.default.compare(password, user.password);
      }).then(correct => {
        isValidPassword = correct;
        const accountLockoutPolicy = new _AccountLockout.default(user, req.config);
        return accountLockoutPolicy.handleLoginAttempt(isValidPassword);
      }).then(async () => {
        if (!isValidPassword) {
          throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Invalid username/password.');
        }
        // A user with an empty ACL (master key only) is considered locked out and
        // cannot log in. This only prevents new logins; existing session tokens
        // remain valid. To immediately revoke access, also destroy the user's
        // sessions via master key.
        if (!req.auth.isMaster && user.ACL && Object.keys(user.ACL).length == 0) {
          throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Invalid username/password.');
        }
        // Create request object for verification functions
        const authProvider = req.body && req.body.authData && Object.keys(req.body.authData).length && Object.keys(req.body.authData).join(',');
        const request = {
          master: req.auth.isMaster,
          ip: req.config.ip,
          installationId: req.auth.installationId,
          object: _node.default.User.fromJSON(Object.assign({
            className: '_User'
          }, user)),
          createdWith: _RestWrite.default.buildCreatedWith('login', authProvider)
        };

        // If request doesn't use master or maintenance key with ignoring email verification
        if (!((req.auth.isMaster || req.auth.isMaintenance) && ignoreEmailVerification)) {
          // Get verification conditions which can be booleans or functions; the purpose of this async/await
          // structure is to avoid unnecessarily executing subsequent functions if previous ones fail in the
          // conditional statement below, as a developer may decide to execute expensive operations in them
          const verifyUserEmails = async () => req.config.verifyUserEmails === true || typeof req.config.verifyUserEmails === 'function' && (await Promise.resolve(req.config.verifyUserEmails(request))) === true;
          const preventLoginWithUnverifiedEmail = async () => req.config.preventLoginWithUnverifiedEmail === true || typeof req.config.preventLoginWithUnverifiedEmail === 'function' && (await Promise.resolve(req.config.preventLoginWithUnverifiedEmail(request))) === true;
          if ((await verifyUserEmails()) && (await preventLoginWithUnverifiedEmail()) && !user.emailVerified) {
            throw new _node.default.Error(_node.default.Error.EMAIL_NOT_FOUND, 'User email is not verified.');
          }
        }
        this._sanitizeAuthData(user);
        return resolve(user);
      }).catch(error => {
        return reject(error);
      });
    });
  }
  async handleMe(req) {
    if (!req.info || !req.info.sessionToken) {
      throw (0, _Error.createSanitizedError)(_node.default.Error.INVALID_SESSION_TOKEN, 'Invalid session token', req.config);
    }
    const sessionToken = req.info.sessionToken;
    // Query the session with master key to validate the session token,
    // but do NOT include 'user' to avoid leaking user data via master context
    const sessionResponse = await _rest.default.find(req.config, _Auth.default.master(req.config), '_Session', {
      sessionToken
    }, {}, req.info.context);
    if (!sessionResponse.results || sessionResponse.results.length == 0 || !sessionResponse.results[0].user) {
      throw (0, _Error.createSanitizedError)(_node.default.Error.INVALID_SESSION_TOKEN, 'Invalid session token', req.config);
    }
    const userId = sessionResponse.results[0].user.objectId;
    // Re-fetch the user with the caller's auth context so that
    // protectedFields, CLP, and auth adapter afterFind apply correctly
    const userResponse = await _rest.default.get(req.config, req.auth, '_User', userId, {}, req.info.context);
    if (!userResponse.results || userResponse.results.length == 0) {
      throw (0, _Error.createSanitizedError)(_node.default.Error.INVALID_SESSION_TOKEN, 'Invalid session token', req.config);
    }
    const user = userResponse.results[0];
    // Send token back on the login, because SDKs expect that.
    user.sessionToken = sessionToken;
    // Remove hidden properties.
    UsersRouter.removeHiddenProperties(user);
    return {
      response: user
    };
  }
  async handleLogIn(req) {
    const user = await this._authenticateUserFromRequest(req);
    const authData = req.body && req.body.authData;
    // Check if user has provided their required auth providers
    _Auth.default.checkIfUserHasProvidedConfiguredProvidersForLogin(req, authData, user.authData, req.config);
    let authDataResponse;
    let validatedAuthData;
    if (authData) {
      // Run the adapters' `beforeFind` (the credential check for code-based adapters) as the
      // signup/link path does, and reject an identity already linked to another user
      const linkedUsers = await _Auth.default.findUsersWithAuthData(req.config, authData, true, user.authData);
      if (linkedUsers.some(linkedUser => linkedUser.objectId !== user.objectId)) {
        throw new _node.default.Error(_node.default.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
      }
      const res = await _Auth.default.handleAuthDataValidation(authData, new _RestWrite.default(req.config, req.auth, '_User', {
        objectId: user.objectId
      }, req.body || {}, user, req.info.context), user);
      authDataResponse = res.authDataResponse;
      validatedAuthData = res.authData;
    }

    // handle password expiry policy
    if (req.config.passwordPolicy && req.config.passwordPolicy.maxPasswordAge) {
      let changedAt = user._password_changed_at;
      if (!changedAt) {
        // password was created before expiry policy was enabled.
        // simply update _User object so that it will start enforcing from now
        changedAt = new Date();
        req.config.database.update('_User', {
          username: user.username
        }, {
          _password_changed_at: _node.default._encode(changedAt)
        });
      } else {
        // check whether the password has expired
        if (changedAt.__type == 'Date') {
          changedAt = new Date(changedAt.iso);
        }
        // Calculate the expiry time.
        const expiresAt = new Date(changedAt.getTime() + 86400000 * req.config.passwordPolicy.maxPasswordAge);
        if (expiresAt < new Date())
          // fail of current time is past password expiry time
          {
            throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Your password has expired. Please reset your password.');
          }
      }
    }

    // Remove hidden properties.
    UsersRouter.removeHiddenProperties(user);
    await req.config.filesController.expandFilesInObject(req.config, user);

    // Before login trigger; throws if failure
    await (0, _triggers.maybeRunTrigger)(_triggers.Types.beforeLogin, req.auth, _node.default.User.fromJSON(Object.assign({
      className: '_User'
    }, user)), null, req.config, req.info.context);

    // If we have some new validated authData update directly
    if (validatedAuthData && Object.keys(validatedAuthData).length) {
      const query = {
        objectId: user.objectId
      };
      // Prevent concurrent requests from both succeeding when consuming single-use
      // tokens (e.g. MFA recovery codes or SMS OTP tokens) by extending the update
      // WHERE clause with the original values of changed primitive/array fields.
      (0, _AuthDataLock.applyAuthDataOptimisticLock)(query, user.authData, validatedAuthData);
      try {
        await req.config.database.update('_User', query, {
          authData: validatedAuthData
        }, {});
      } catch (error) {
        if (error.code === _node.default.Error.OBJECT_NOT_FOUND) {
          throw new _node.default.Error(_node.default.Error.SCRIPT_FAILED, 'Invalid auth data');
        }
        throw error;
      }
    }
    const {
      sessionData,
      createSession
    } = _RestWrite.default.createSession(req.config, {
      userId: user.objectId,
      createdWith: _RestWrite.default.buildCreatedWith('login'),
      installationId: req.info.installationId
    });
    user.sessionToken = sessionData.sessionToken;
    await createSession();
    const afterLoginUser = _node.default.User.fromJSON(Object.assign({
      className: '_User'
    }, user));
    await (0, _triggers.maybeRunTrigger)(_triggers.Types.afterLogin, {
      ...req.auth,
      user: afterLoginUser
    }, afterLoginUser, null, req.config, req.info.context);

    // Re-fetch the user with the caller's auth context so that
    // protectedFields and CLP apply correctly; if the caller used master key,
    // protectedFields are bypassed, matching the behavior of GET /users/:id
    const refetchAuth = req.auth.isMaster || req.auth.isMaintenance ? req.auth : new _Auth.default.Auth({
      config: req.config,
      isMaster: false,
      user: _node.default.Object.fromJSON({
        className: '_User',
        objectId: user.objectId
      }),
      installationId: req.info.installationId
    });
    let filteredUser;
    try {
      const filteredUserResponse = await _rest.default.get(req.config, refetchAuth, '_User', user.objectId, {}, req.info.context);
      filteredUser = filteredUserResponse.results?.[0];
    } catch {
      // The re-fetch enforces `_User` `get` CLP and may be denied by access
      // control (e.g. CLP `get: {}` or an ACL that excludes the caller).
      // Handled below; never fall back to the raw row.
    }
    if (!filteredUser) {
      // Master/maintenance callers bypass CLP, protectedFields, and authData
      // afterFind, so for them an empty re-fetch is a genuine not-found edge, not
      // an access-control denial; they are entitled to the full row. For every
      // other caller, an empty/denied re-fetch means access control withheld the
      // record, so disclose only the identity — never the raw row, which would
      // leak fields hidden by `protectedFields` and raw `authData` (e.g. MFA
      // secrets and recovery codes) that the sanitizing re-fetch would remove.
      // The session token is still attached below so login succeeds.
      filteredUser = req.auth.isMaster || req.auth.isMaintenance ? user : {
        objectId: user.objectId
      };
    }
    UsersRouter.removeHiddenProperties(filteredUser);
    filteredUser.sessionToken = user.sessionToken;
    if (authDataResponse) {
      filteredUser.authDataResponse = authDataResponse;
    }
    return {
      response: filteredUser
    };
  }

  /**
   * This allows master-key clients to create user sessions without access to
   * user credentials. This enables systems that can authenticate access another
   * way (API key, app administrators) to act on a user's behalf.
   *
   * We create a new session rather than looking for an existing session; we
   * want this to work in situations where the user is logged out on all
   * devices, since this can be used by automated systems acting on the user's
   * behalf.
   *
   * For the moment, we're omitting event hooks and lockout checks, since
   * immediate use cases suggest /loginAs could be used for semantically
   * different reasons from /login
   */
  async handleLogInAs(req) {
    if (!req.auth.isMaster) {
      throw (0, _Error.createSanitizedError)(_node.default.Error.OPERATION_FORBIDDEN, 'master key is required', req.config);
    }
    if (req.auth.isReadOnly) {
      throw (0, _Error.createSanitizedError)(_node.default.Error.OPERATION_FORBIDDEN, "read-only masterKey isn't allowed to login as another user.", req.config);
    }
    const userId = req.body?.userId || req.query.userId;
    if (!userId) {
      throw new _node.default.Error(_node.default.Error.INVALID_VALUE, 'userId must not be empty, null, or undefined');
    }
    const queryResults = await req.config.database.find('_User', {
      objectId: userId
    });
    const user = queryResults[0];
    if (!user) {
      throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'user not found');
    }
    this._sanitizeAuthData(user);
    const {
      sessionData,
      createSession
    } = _RestWrite.default.createSession(req.config, {
      userId,
      createdWith: _RestWrite.default.buildCreatedWith('login', 'masterkey'),
      installationId: req.info.installationId
    });
    user.sessionToken = sessionData.sessionToken;
    await createSession();
    return {
      response: user
    };
  }
  handleVerifyPassword(req) {
    return this._authenticateUserFromRequest(req).then(async user => {
      // Remove hidden properties.
      UsersRouter.removeHiddenProperties(user);
      // Re-fetch the user with the caller's auth context so that
      // protectedFields and CLP apply correctly; if the caller used master key,
      // protectedFields are bypassed, matching the behavior of GET /users/:id
      const refetchAuth = req.auth.isMaster || req.auth.isMaintenance ? req.auth : new _Auth.default.Auth({
        config: req.config,
        isMaster: false,
        user: _node.default.Object.fromJSON({
          className: '_User',
          objectId: user.objectId
        }),
        installationId: req.info.installationId
      });
      let filteredUser;
      try {
        const filteredUserResponse = await _rest.default.get(req.config, refetchAuth, '_User', user.objectId, {}, req.info.context);
        filteredUser = filteredUserResponse.results?.[0];
      } catch {
        // The re-fetch enforces `_User` `get` CLP and may be denied by access
        // control (e.g. CLP `get: {}` or an ACL that excludes the caller).
        // Handled below; never fall back to the raw row.
      }
      if (!filteredUser) {
        // See handleLogIn: master/maintenance callers bypass CLP,
        // protectedFields, and authData afterFind, so an empty re-fetch is a
        // genuine not-found edge for them and they are entitled to the full
        // row. For all other callers, an empty/denied re-fetch means access
        // control withheld the record, so disclose only the identity rather
        // than the raw row, which would leak protectedFields and raw authData
        // (e.g. MFA secrets and recovery codes).
        filteredUser = req.auth.isMaster || req.auth.isMaintenance ? user : {
          objectId: user.objectId
        };
      }
      UsersRouter.removeHiddenProperties(filteredUser);
      return {
        response: filteredUser
      };
    }).catch(error => {
      throw error;
    });
  }
  async handleLogOut(req) {
    const success = {
      response: {}
    };
    if (req.info && req.info.sessionToken) {
      const records = await _rest.default.find(req.config, _Auth.default.master(req.config), '_Session', {
        sessionToken: req.info.sessionToken
      }, undefined, req.info.context);
      if (records.results && records.results.length) {
        await _rest.default.del(req.config, _Auth.default.master(req.config), '_Session', records.results[0].objectId, req.info.context);
        await (0, _triggers.maybeRunTrigger)(_triggers.Types.afterLogout, req.auth, _node.default.Session.fromJSON(Object.assign({
          className: '_Session'
        }, records.results[0])), null, req.config);
      }
    }
    return success;
  }
  _throwOnBadEmailConfig(req) {
    try {
      _Config.default.validateEmailConfiguration({
        emailAdapter: req.config.userController.adapter,
        appName: req.config.appName,
        publicServerURL: req.config.publicServerURL || req.config._publicServerURL,
        emailVerifyTokenValidityDuration: req.config.emailVerifyTokenValidityDuration,
        emailVerifyTokenReuseIfValid: req.config.emailVerifyTokenReuseIfValid
      });
    } catch (e) {
      if (typeof e === 'string') {
        // Maybe we need a Bad Configuration error, but the SDKs won't understand it. For now, Internal Server Error.
        throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'An appName, publicServerURL, and emailAdapter are required for password reset and email verification functionality.');
      } else {
        throw e;
      }
    }
  }
  async handleResetRequest(req) {
    this._throwOnBadEmailConfig(req);
    let email = req.body?.email;
    const token = req.body?.token;
    if (!email && !token) {
      throw new _node.default.Error(_node.default.Error.EMAIL_MISSING, 'you must provide an email');
    }
    if (token && typeof token !== 'string') {
      throw new _node.default.Error(_node.default.Error.INVALID_VALUE, 'token must be a string');
    }
    let userResults = null;
    let userData = null;

    // We can find the user using token
    if (token) {
      userResults = await req.config.database.find('_User', {
        _perishable_token: token,
        _perishable_token_expires_at: {
          $lt: _node.default._encode(new Date())
        }
      });
      if (userResults?.length > 0) {
        userData = userResults[0];
        if (userData.email) {
          email = userData.email;
        }
      }
      // Or using email if no token provided
    } else if (typeof email === 'string') {
      userResults = await req.config.database.find('_User', {
        $or: [{
          email
        }, {
          username: email,
          email: {
            $exists: false
          }
        }]
      }, {
        limit: 1
      }, _Auth.default.maintenance(req.config));
      if (userResults?.length > 0) {
        userData = userResults[0];
      }
    }
    if (typeof email !== 'string') {
      throw new _node.default.Error(_node.default.Error.INVALID_EMAIL_ADDRESS, 'you must provide a valid email string');
    }
    if (userData) {
      this._sanitizeAuthData(userData);
      // Get files attached to user
      await req.config.filesController.expandFilesInObject(req.config, userData);
      const user = (0, _triggers.inflate)('_User', userData);
      await (0, _triggers.maybeRunTrigger)(_triggers.Types.beforePasswordResetRequest, req.auth, user, null, req.config, req.info.context);
    }
    const userController = req.config.userController;
    try {
      await userController.sendPasswordResetEmail(email);
      return {
        response: {}
      };
    } catch (err) {
      if (err.code === _node.default.Error.OBJECT_NOT_FOUND) {
        if (req.config.passwordPolicy?.resetPasswordSuccessOnInvalidEmail ?? true) {
          return {
            response: {}
          };
        }
        err.message = `A user with that email does not exist.`;
      }
      throw err;
    }
  }
  async handleVerificationEmailRequest(req) {
    this._throwOnBadEmailConfig(req);
    const {
      email
    } = req.body || {};
    if (!email) {
      throw new _node.default.Error(_node.default.Error.EMAIL_MISSING, 'you must provide an email');
    }
    if (typeof email !== 'string') {
      throw new _node.default.Error(_node.default.Error.INVALID_EMAIL_ADDRESS, 'you must provide a valid email string');
    }
    const verifyEmailSuccessOnInvalidEmail = req.config.emailVerifySuccessOnInvalidEmail ?? true;
    const results = await req.config.database.find('_User', {
      email: email
    }, {}, _Auth.default.maintenance(req.config));
    if (!results.length || results.length < 1) {
      if (verifyEmailSuccessOnInvalidEmail) {
        return {
          response: {}
        };
      }
      throw new _node.default.Error(_node.default.Error.EMAIL_NOT_FOUND, `No user found with email ${email}`);
    }
    const user = results[0];

    // remove password field, messes with saving on postgres
    delete user.password;
    if (user.emailVerified) {
      if (verifyEmailSuccessOnInvalidEmail) {
        return {
          response: {}
        };
      }
      throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, `Email ${email} is already verified.`);
    }
    const userController = req.config.userController;
    const send = await userController.regenerateEmailVerifyToken(user, req.auth.isMaster, req.auth.installationId, req.ip);
    if (send) {
      userController.sendVerificationEmail(user, req);
    }
    return {
      response: {}
    };
  }
  async handleChallenge(req) {
    const {
      username,
      email,
      password,
      authData,
      challengeData
    } = req.body || {};

    // if username or email provided with password try to authenticate the user by username
    let user;
    if (username || email) {
      if (!password) {
        throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'You provided username or email, you need to also provide password.');
      }
      user = await this._authenticateUserFromRequest(req);
    }
    if (!challengeData) {
      throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'Nothing to challenge.');
    }
    if (typeof challengeData !== 'object') {
      throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'challengeData should be an object.');
    }
    let request;
    let parseUser;

    // Try to find user by authData
    if (authData) {
      if (typeof authData !== 'object') {
        throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'authData should be an object.');
      }
      if (user) {
        throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'You cannot provide username/email and authData, only use one identification method.');
      }
      for (const key of Object.keys(authData)) {
        if (authData[key] !== null && (typeof authData[key] !== 'object' || Array.isArray(authData[key]))) {
          throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, `authData.${key} should be an object.`);
        }
      }
      if (Object.keys(authData).filter(key => authData[key] && authData[key].id).length > 1) {
        throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'You cannot provide more than one authData provider with an id.');
      }
      try {
        // Run `beforeFind` so a bare client-supplied provider id cannot select the user
        const results = await _Auth.default.findUsersWithAuthData(req.config, authData, true);
        if (!results[0] || results.length > 1) {
          throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'User not found.');
        }
        // Find the provider used to find the user
        const provider = Object.keys(authData).find(key => authData[key] && authData[key].id);
        parseUser = _node.default.User.fromJSON({
          className: '_User',
          ...results[0]
        });
        request = (0, _triggers.getRequestObject)(undefined, req.auth, parseUser, parseUser, req.config);
        request.isChallenge = true;
        // Validate authData used to identify the user to avoid brute-force attack on `id`
        const {
          validator
        } = req.config.authDataManager.getValidatorForProvider(provider);
        const validatorResponse = await validator(authData[provider], req, parseUser, request);
        if (validatorResponse && validatorResponse.validator) {
          await validatorResponse.validator();
        }
      } catch (e) {
        // Rewrite the error to avoid guess id attack
        _logger.logger.error(e);
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'User not found.');
      }
    }
    if (!parseUser) {
      parseUser = user ? _node.default.User.fromJSON({
        className: '_User',
        ...user
      }) : undefined;
    }
    if (!request) {
      request = (0, _triggers.getRequestObject)(undefined, req.auth, parseUser, parseUser, req.config);
      request.isChallenge = true;
    }
    const acc = {};
    // Execute challenge step-by-step with consistent order for better error feedback
    // and to avoid to trigger others challenges if one of them fails
    for (const provider of Object.keys(challengeData).sort()) {
      try {
        const authAdapter = req.config.authDataManager.getValidatorForProvider(provider);
        if (!authAdapter) {
          continue;
        }
        const {
          adapter: {
            challenge
          }
        } = authAdapter;
        if (typeof challenge === 'function') {
          const providerChallengeResponse = await challenge(challengeData[provider], authData && authData[provider], req.config.auth[provider], request);
          acc[provider] = providerChallengeResponse || true;
        }
      } catch (err) {
        const e = (0, _triggers.resolveError)(err, {
          code: _node.default.Error.SCRIPT_FAILED,
          message: 'Challenge failed. Unknown error.'
        });
        const userString = req.auth && req.auth.user ? req.auth.user.id : undefined;
        _logger.logger.error(`Failed running auth step challenge for ${provider} for user ${userString} with Error: ` + JSON.stringify(e), {
          authenticationStep: 'challenge',
          error: e,
          user: userString,
          provider
        });
        throw e;
      }
    }
    return {
      response: {
        challengeData: acc
      }
    };
  }
  mountRoutes() {
    this.route('GET', '/users', req => {
      return this.handleFind(req);
    });
    this.route('POST', '/users', _middlewares.promiseEnsureIdempotency, req => {
      return this.handleCreate(req);
    });
    this.route('GET', '/users/me', req => {
      return this.handleMe(req);
    });
    this.route('GET', '/users/:objectId', req => {
      return this.handleGet(req);
    });
    this.route('PUT', '/users/:objectId', _middlewares.promiseEnsureIdempotency, req => {
      return this.handleUpdate(req);
    });
    this.route('DELETE', '/users/:objectId', req => {
      return this.handleDelete(req);
    });
    this.route('GET', '/login', req => {
      return this.handleLogIn(req);
    });
    this.route('POST', '/login', req => {
      return this.handleLogIn(req);
    });
    this.route('POST', '/loginAs', req => {
      return this.handleLogInAs(req);
    });
    this.route('POST', '/logout', req => {
      return this.handleLogOut(req);
    });
    this.route('POST', '/requestPasswordReset', req => {
      return this.handleResetRequest(req);
    });
    this.route('POST', '/verificationEmailRequest', req => {
      return this.handleVerificationEmailRequest(req);
    });
    this.route('GET', '/verifyPassword', req => {
      return this.handleVerifyPassword(req);
    });
    this.route('POST', '/verifyPassword', req => {
      return this.handleVerifyPassword(req);
    });
    this.route('POST', '/challenge', req => {
      return this.handleChallenge(req);
    });
  }
}
exports.UsersRouter = UsersRouter;
var _default = exports.default = UsersRouter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX0NvbmZpZyIsIl9BY2NvdW50TG9ja291dCIsIl9DbGFzc2VzUm91dGVyIiwiX3Jlc3QiLCJfQXV0aCIsIl9wYXNzd29yZCIsIl90cmlnZ2VycyIsIl9taWRkbGV3YXJlcyIsIl9SZXN0V3JpdGUiLCJfbG9nZ2VyIiwiX0Vycm9yIiwiX0F1dGhEYXRhTG9jayIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsIlVzZXJzUm91dGVyIiwiQ2xhc3Nlc1JvdXRlciIsImNsYXNzTmFtZSIsInJlbW92ZUhpZGRlblByb3BlcnRpZXMiLCJvYmoiLCJrZXkiLCJPYmplY3QiLCJwcm90b3R5cGUiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJ0ZXN0IiwiX3Nhbml0aXplQXV0aERhdGEiLCJ1c2VyIiwicGFzc3dvcmQiLCJhdXRoRGF0YSIsImtleXMiLCJmb3JFYWNoIiwicHJvdmlkZXIiLCJsZW5ndGgiLCJfYXV0aGVudGljYXRlVXNlckZyb21SZXF1ZXN0IiwicmVxIiwiUHJvbWlzZSIsInJlc29sdmUiLCJyZWplY3QiLCJwYXlsb2FkIiwiYm9keSIsInVzZXJuYW1lIiwicXVlcnkiLCJlbWFpbCIsImlnbm9yZUVtYWlsVmVyaWZpY2F0aW9uIiwiUGFyc2UiLCJFcnJvciIsIlVTRVJOQU1FX01JU1NJTkciLCJQQVNTV09SRF9NSVNTSU5HIiwiT0JKRUNUX05PVF9GT1VORCIsImlzVmFsaWRQYXNzd29yZCIsIiRvciIsImNvbmZpZyIsImRhdGFiYXNlIiwiZmluZCIsIkF1dGgiLCJtYWludGVuYW5jZSIsInRoZW4iLCJyZXN1bHRzIiwicGFzc3dvcmRDcnlwdG8iLCJjb21wYXJlIiwiZHVtbXlIYXNoIiwibG9nZ2VyQ29udHJvbGxlciIsIndhcm4iLCJmaWx0ZXIiLCJjb3JyZWN0IiwiYWNjb3VudExvY2tvdXRQb2xpY3kiLCJBY2NvdW50TG9ja291dCIsImhhbmRsZUxvZ2luQXR0ZW1wdCIsImF1dGgiLCJpc01hc3RlciIsIkFDTCIsImF1dGhQcm92aWRlciIsImpvaW4iLCJyZXF1ZXN0IiwibWFzdGVyIiwiaXAiLCJpbnN0YWxsYXRpb25JZCIsIm9iamVjdCIsIlVzZXIiLCJmcm9tSlNPTiIsImFzc2lnbiIsImNyZWF0ZWRXaXRoIiwiUmVzdFdyaXRlIiwiYnVpbGRDcmVhdGVkV2l0aCIsImlzTWFpbnRlbmFuY2UiLCJ2ZXJpZnlVc2VyRW1haWxzIiwicHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCIsImVtYWlsVmVyaWZpZWQiLCJFTUFJTF9OT1RfRk9VTkQiLCJjYXRjaCIsImVycm9yIiwiaGFuZGxlTWUiLCJpbmZvIiwic2Vzc2lvblRva2VuIiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCJzZXNzaW9uUmVzcG9uc2UiLCJyZXN0IiwiY29udGV4dCIsInVzZXJJZCIsIm9iamVjdElkIiwidXNlclJlc3BvbnNlIiwiZ2V0IiwicmVzcG9uc2UiLCJoYW5kbGVMb2dJbiIsImNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4iLCJhdXRoRGF0YVJlc3BvbnNlIiwidmFsaWRhdGVkQXV0aERhdGEiLCJsaW5rZWRVc2VycyIsImZpbmRVc2Vyc1dpdGhBdXRoRGF0YSIsInNvbWUiLCJsaW5rZWRVc2VyIiwiQUNDT1VOVF9BTFJFQURZX0xJTktFRCIsInJlcyIsImhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiIsInBhc3N3b3JkUG9saWN5IiwibWF4UGFzc3dvcmRBZ2UiLCJjaGFuZ2VkQXQiLCJfcGFzc3dvcmRfY2hhbmdlZF9hdCIsIkRhdGUiLCJ1cGRhdGUiLCJfZW5jb2RlIiwiX190eXBlIiwiaXNvIiwiZXhwaXJlc0F0IiwiZ2V0VGltZSIsImZpbGVzQ29udHJvbGxlciIsImV4cGFuZEZpbGVzSW5PYmplY3QiLCJtYXliZVJ1blRyaWdnZXIiLCJUcmlnZ2VyVHlwZXMiLCJiZWZvcmVMb2dpbiIsImFwcGx5QXV0aERhdGFPcHRpbWlzdGljTG9jayIsImNvZGUiLCJTQ1JJUFRfRkFJTEVEIiwic2Vzc2lvbkRhdGEiLCJjcmVhdGVTZXNzaW9uIiwiYWZ0ZXJMb2dpblVzZXIiLCJhZnRlckxvZ2luIiwicmVmZXRjaEF1dGgiLCJmaWx0ZXJlZFVzZXIiLCJmaWx0ZXJlZFVzZXJSZXNwb25zZSIsImhhbmRsZUxvZ0luQXMiLCJPUEVSQVRJT05fRk9SQklEREVOIiwiaXNSZWFkT25seSIsIklOVkFMSURfVkFMVUUiLCJxdWVyeVJlc3VsdHMiLCJoYW5kbGVWZXJpZnlQYXNzd29yZCIsImhhbmRsZUxvZ091dCIsInN1Y2Nlc3MiLCJyZWNvcmRzIiwidW5kZWZpbmVkIiwiZGVsIiwiYWZ0ZXJMb2dvdXQiLCJTZXNzaW9uIiwiX3Rocm93T25CYWRFbWFpbENvbmZpZyIsIkNvbmZpZyIsInZhbGlkYXRlRW1haWxDb25maWd1cmF0aW9uIiwiZW1haWxBZGFwdGVyIiwidXNlckNvbnRyb2xsZXIiLCJhZGFwdGVyIiwiYXBwTmFtZSIsInB1YmxpY1NlcnZlclVSTCIsIl9wdWJsaWNTZXJ2ZXJVUkwiLCJlbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbiIsImVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJoYW5kbGVSZXNldFJlcXVlc3QiLCJ0b2tlbiIsIkVNQUlMX01JU1NJTkciLCJ1c2VyUmVzdWx0cyIsInVzZXJEYXRhIiwiX3BlcmlzaGFibGVfdG9rZW4iLCJfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0IiwiJGx0IiwiJGV4aXN0cyIsImxpbWl0IiwiSU5WQUxJRF9FTUFJTF9BRERSRVNTIiwiaW5mbGF0ZSIsImJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0Iiwic2VuZFBhc3N3b3JkUmVzZXRFbWFpbCIsImVyciIsInJlc2V0UGFzc3dvcmRTdWNjZXNzT25JbnZhbGlkRW1haWwiLCJtZXNzYWdlIiwiaGFuZGxlVmVyaWZpY2F0aW9uRW1haWxSZXF1ZXN0IiwidmVyaWZ5RW1haWxTdWNjZXNzT25JbnZhbGlkRW1haWwiLCJlbWFpbFZlcmlmeVN1Y2Nlc3NPbkludmFsaWRFbWFpbCIsIk9USEVSX0NBVVNFIiwic2VuZCIsInJlZ2VuZXJhdGVFbWFpbFZlcmlmeVRva2VuIiwic2VuZFZlcmlmaWNhdGlvbkVtYWlsIiwiaGFuZGxlQ2hhbGxlbmdlIiwiY2hhbGxlbmdlRGF0YSIsInBhcnNlVXNlciIsIkFycmF5IiwiaXNBcnJheSIsImlkIiwiZ2V0UmVxdWVzdE9iamVjdCIsImlzQ2hhbGxlbmdlIiwidmFsaWRhdG9yIiwiYXV0aERhdGFNYW5hZ2VyIiwiZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIiLCJ2YWxpZGF0b3JSZXNwb25zZSIsImxvZ2dlciIsImFjYyIsInNvcnQiLCJhdXRoQWRhcHRlciIsImNoYWxsZW5nZSIsInByb3ZpZGVyQ2hhbGxlbmdlUmVzcG9uc2UiLCJyZXNvbHZlRXJyb3IiLCJ1c2VyU3RyaW5nIiwiSlNPTiIsInN0cmluZ2lmeSIsImF1dGhlbnRpY2F0aW9uU3RlcCIsIm1vdW50Um91dGVzIiwicm91dGUiLCJoYW5kbGVGaW5kIiwicHJvbWlzZUVuc3VyZUlkZW1wb3RlbmN5IiwiaGFuZGxlQ3JlYXRlIiwiaGFuZGxlR2V0IiwiaGFuZGxlVXBkYXRlIiwiaGFuZGxlRGVsZXRlIiwiZXhwb3J0cyIsIl9kZWZhdWx0Il0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL1JvdXRlcnMvVXNlcnNSb3V0ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gVGhlc2UgbWV0aG9kcyBoYW5kbGUgdGhlIFVzZXItcmVsYXRlZCByb3V0ZXMuXG5cbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbmltcG9ydCBDb25maWcgZnJvbSAnLi4vQ29uZmlnJztcbmltcG9ydCBBY2NvdW50TG9ja291dCBmcm9tICcuLi9BY2NvdW50TG9ja291dCc7XG5pbXBvcnQgQ2xhc3Nlc1JvdXRlciBmcm9tICcuL0NsYXNzZXNSb3V0ZXInO1xuaW1wb3J0IHJlc3QgZnJvbSAnLi4vcmVzdCc7XG5pbXBvcnQgQXV0aCBmcm9tICcuLi9BdXRoJztcbmltcG9ydCBwYXNzd29yZENyeXB0byBmcm9tICcuLi9wYXNzd29yZCc7XG5pbXBvcnQge1xuICBtYXliZVJ1blRyaWdnZXIsXG4gIFR5cGVzIGFzIFRyaWdnZXJUeXBlcyxcbiAgZ2V0UmVxdWVzdE9iamVjdCxcbiAgcmVzb2x2ZUVycm9yLFxuICBpbmZsYXRlLFxufSBmcm9tICcuLi90cmlnZ2Vycyc7XG5pbXBvcnQgeyBwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3kgfSBmcm9tICcuLi9taWRkbGV3YXJlcyc7XG5pbXBvcnQgUmVzdFdyaXRlIGZyb20gJy4uL1Jlc3RXcml0ZSc7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tICcuLi9sb2dnZXInO1xuaW1wb3J0IHsgY3JlYXRlU2FuaXRpemVkRXJyb3IgfSBmcm9tICcuLi9FcnJvcic7XG5pbXBvcnQgeyBhcHBseUF1dGhEYXRhT3B0aW1pc3RpY0xvY2sgfSBmcm9tICcuLi9BdXRoRGF0YUxvY2snO1xuXG5leHBvcnQgY2xhc3MgVXNlcnNSb3V0ZXIgZXh0ZW5kcyBDbGFzc2VzUm91dGVyIHtcbiAgY2xhc3NOYW1lKCkge1xuICAgIHJldHVybiAnX1VzZXInO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlbW92ZXMgYWxsIFwiX1wiIHByZWZpeGVkIHByb3BlcnRpZXMgZnJvbSBhbiBvYmplY3QsIGV4Y2VwdCBcIl9fdHlwZVwiXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBvYmogQW4gb2JqZWN0LlxuICAgKi9cbiAgc3RhdGljIHJlbW92ZUhpZGRlblByb3BlcnRpZXMob2JqKSB7XG4gICAgZm9yICh2YXIga2V5IGluIG9iaikge1xuICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIGtleSkpIHtcbiAgICAgICAgLy8gUmVnZXhwIGNvbWVzIGZyb20gUGFyc2UuT2JqZWN0LnByb3RvdHlwZS52YWxpZGF0ZVxuICAgICAgICBpZiAoa2V5ICE9PSAnX190eXBlJyAmJiAhL15bQS1aYS16XVswLTlBLVphLXpfXSokLy50ZXN0KGtleSkpIHtcbiAgICAgICAgICBkZWxldGUgb2JqW2tleV07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQWZ0ZXIgcmV0cmlldmluZyBhIHVzZXIgZGlyZWN0bHkgZnJvbSB0aGUgZGF0YWJhc2UsIHdlIG5lZWQgdG8gcmVtb3ZlIHRoZVxuICAgKiBwYXNzd29yZCBmcm9tIHRoZSBvYmplY3QgKGZvciBzZWN1cml0eSksIGFuZCBmaXggYW4gaXNzdWUgc29tZSBTREtzIGhhdmVcbiAgICogd2l0aCBudWxsIHZhbHVlc1xuICAgKi9cbiAgX3Nhbml0aXplQXV0aERhdGEodXNlcikge1xuICAgIGRlbGV0ZSB1c2VyLnBhc3N3b3JkO1xuXG4gICAgLy8gU29tZXRpbWVzIHRoZSBhdXRoRGF0YSBzdGlsbCBoYXMgbnVsbCBvbiB0aGF0IGtleXNcbiAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vcGFyc2UtY29tbXVuaXR5L3BhcnNlLXNlcnZlci9pc3N1ZXMvOTM1XG4gICAgaWYgKHVzZXIuYXV0aERhdGEpIHtcbiAgICAgIE9iamVjdC5rZXlzKHVzZXIuYXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICBpZiAodXNlci5hdXRoRGF0YVtwcm92aWRlcl0gPT09IG51bGwpIHtcbiAgICAgICAgICBkZWxldGUgdXNlci5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgaWYgKE9iamVjdC5rZXlzKHVzZXIuYXV0aERhdGEpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZXMgYSBwYXNzd29yZCByZXF1ZXN0IGluIGxvZ2luIGFuZCB2ZXJpZnlQYXNzd29yZFxuICAgKiBAcGFyYW0ge09iamVjdH0gcmVxIFRoZSByZXF1ZXN0XG4gICAqIEByZXR1cm5zIHtPYmplY3R9IFVzZXIgb2JqZWN0XG4gICAqIEBwcml2YXRlXG4gICAqL1xuICBfYXV0aGVudGljYXRlVXNlckZyb21SZXF1ZXN0KHJlcSkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAvLyBVc2UgcXVlcnkgcGFyYW1ldGVycyBpbnN0ZWFkIGlmIHByb3ZpZGVkIGluIHVybFxuICAgICAgbGV0IHBheWxvYWQgPSByZXEuYm9keSB8fCB7fTtcbiAgICAgIGlmIChcbiAgICAgICAgKCFwYXlsb2FkLnVzZXJuYW1lICYmIHJlcS5xdWVyeSAmJiByZXEucXVlcnkudXNlcm5hbWUpIHx8XG4gICAgICAgICghcGF5bG9hZC5lbWFpbCAmJiByZXEucXVlcnkgJiYgcmVxLnF1ZXJ5LmVtYWlsKVxuICAgICAgKSB7XG4gICAgICAgIHBheWxvYWQgPSByZXEucXVlcnk7XG4gICAgICB9XG4gICAgICBjb25zdCB7IHVzZXJuYW1lLCBlbWFpbCwgcGFzc3dvcmQsIGlnbm9yZUVtYWlsVmVyaWZpY2F0aW9uIH0gPSBwYXlsb2FkO1xuXG4gICAgICAvLyBUT0RPOiB1c2UgdGhlIHJpZ2h0IGVycm9yIGNvZGVzIC8gZGVzY3JpcHRpb25zLlxuICAgICAgaWYgKCF1c2VybmFtZSAmJiAhZW1haWwpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlVTRVJOQU1FX01JU1NJTkcsICd1c2VybmFtZS9lbWFpbCBpcyByZXF1aXJlZC4nKTtcbiAgICAgIH1cbiAgICAgIGlmICghcGFzc3dvcmQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlBBU1NXT1JEX01JU1NJTkcsICdwYXNzd29yZCBpcyByZXF1aXJlZC4nKTtcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgdHlwZW9mIHBhc3N3b3JkICE9PSAnc3RyaW5nJyB8fFxuICAgICAgICAoZW1haWwgJiYgdHlwZW9mIGVtYWlsICE9PSAnc3RyaW5nJykgfHxcbiAgICAgICAgKHVzZXJuYW1lICYmIHR5cGVvZiB1c2VybmFtZSAhPT0gJ3N0cmluZycpXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdJbnZhbGlkIHVzZXJuYW1lL3Bhc3N3b3JkLicpO1xuICAgICAgfVxuXG4gICAgICBsZXQgdXNlcjtcbiAgICAgIGxldCBpc1ZhbGlkUGFzc3dvcmQgPSBmYWxzZTtcbiAgICAgIGxldCBxdWVyeTtcbiAgICAgIGlmIChlbWFpbCAmJiB1c2VybmFtZSkge1xuICAgICAgICBxdWVyeSA9IHsgZW1haWwsIHVzZXJuYW1lIH07XG4gICAgICB9IGVsc2UgaWYgKGVtYWlsKSB7XG4gICAgICAgIHF1ZXJ5ID0geyBlbWFpbCB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcXVlcnkgPSB7ICRvcjogW3sgdXNlcm5hbWUgfSwgeyBlbWFpbDogdXNlcm5hbWUgfV0gfTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXEuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgIC5maW5kKCdfVXNlcicsIHF1ZXJ5LCB7fSwgQXV0aC5tYWludGVuYW5jZShyZXEuY29uZmlnKSlcbiAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgaWYgKCFyZXN1bHRzLmxlbmd0aCkge1xuICAgICAgICAgICAgLy8gUGVyZm9ybSBhIGR1bW15IGJjcnlwdCBjb21wYXJlIHRvIG5vcm1hbGl6ZSByZXNwb25zZSB0aW1pbmcsXG4gICAgICAgICAgICAvLyBwcmV2ZW50aW5nIHVzZXIgZW51bWVyYXRpb24gdmlhIHRpbWluZyBzaWRlLWNoYW5uZWxcbiAgICAgICAgICAgIHJldHVybiBwYXNzd29yZENyeXB0b1xuICAgICAgICAgICAgICAuY29tcGFyZShwYXNzd29yZCwgcGFzc3dvcmRDcnlwdG8uZHVtbXlIYXNoKVxuICAgICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdJbnZhbGlkIHVzZXJuYW1lL3Bhc3N3b3JkLicpO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICAvLyBjb3JuZXIgY2FzZSB3aGVyZSB1c2VyMSBoYXMgdXNlcm5hbWUgPT0gdXNlcjIgZW1haWxcbiAgICAgICAgICAgIHJlcS5jb25maWcubG9nZ2VyQ29udHJvbGxlci53YXJuKFxuICAgICAgICAgICAgICBcIlRoZXJlIGlzIGEgdXNlciB3aGljaCBlbWFpbCBpcyB0aGUgc2FtZSBhcyBhbm90aGVyIHVzZXIncyB1c2VybmFtZSwgbG9nZ2luZyBpbiBiYXNlZCBvbiB1c2VybmFtZVwiXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgdXNlciA9IHJlc3VsdHMuZmlsdGVyKHVzZXIgPT4gdXNlci51c2VybmFtZSA9PT0gdXNlcm5hbWUpWzBdO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1c2VyID0gcmVzdWx0c1swXTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAodHlwZW9mIHVzZXIucGFzc3dvcmQgIT09ICdzdHJpbmcnIHx8IHVzZXIucGFzc3dvcmQubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAvLyBQYXNzd29yZGxlc3MgYWNjb3VudCAoZS5nLiBPQXV0aC1vbmx5KTogcnVuIGR1bW15IGNvbXBhcmUgZm9yXG4gICAgICAgICAgICAvLyB0aW1pbmcgbm9ybWFsaXphdGlvbiwgZGlzY2FyZCByZXN1bHQsIGFsd2F5cyByZWplY3RcbiAgICAgICAgICAgIHJldHVybiBwYXNzd29yZENyeXB0by5jb21wYXJlKHBhc3N3b3JkLCBwYXNzd29yZENyeXB0by5kdW1teUhhc2gpLnRoZW4oKCkgPT4gZmFsc2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uY29tcGFyZShwYXNzd29yZCwgdXNlci5wYXNzd29yZCk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKGNvcnJlY3QgPT4ge1xuICAgICAgICAgIGlzVmFsaWRQYXNzd29yZCA9IGNvcnJlY3Q7XG4gICAgICAgICAgY29uc3QgYWNjb3VudExvY2tvdXRQb2xpY3kgPSBuZXcgQWNjb3VudExvY2tvdXQodXNlciwgcmVxLmNvbmZpZyk7XG4gICAgICAgICAgcmV0dXJuIGFjY291bnRMb2Nrb3V0UG9saWN5LmhhbmRsZUxvZ2luQXR0ZW1wdChpc1ZhbGlkUGFzc3dvcmQpO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgICAgaWYgKCFpc1ZhbGlkUGFzc3dvcmQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnSW52YWxpZCB1c2VybmFtZS9wYXNzd29yZC4nKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gQSB1c2VyIHdpdGggYW4gZW1wdHkgQUNMIChtYXN0ZXIga2V5IG9ubHkpIGlzIGNvbnNpZGVyZWQgbG9ja2VkIG91dCBhbmRcbiAgICAgICAgICAvLyBjYW5ub3QgbG9nIGluLiBUaGlzIG9ubHkgcHJldmVudHMgbmV3IGxvZ2luczsgZXhpc3Rpbmcgc2Vzc2lvbiB0b2tlbnNcbiAgICAgICAgICAvLyByZW1haW4gdmFsaWQuIFRvIGltbWVkaWF0ZWx5IHJldm9rZSBhY2Nlc3MsIGFsc28gZGVzdHJveSB0aGUgdXNlcidzXG4gICAgICAgICAgLy8gc2Vzc2lvbnMgdmlhIG1hc3RlciBrZXkuXG4gICAgICAgICAgaWYgKCFyZXEuYXV0aC5pc01hc3RlciAmJiB1c2VyLkFDTCAmJiBPYmplY3Qua2V5cyh1c2VyLkFDTCkubGVuZ3RoID09IDApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnSW52YWxpZCB1c2VybmFtZS9wYXNzd29yZC4nKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gQ3JlYXRlIHJlcXVlc3Qgb2JqZWN0IGZvciB2ZXJpZmljYXRpb24gZnVuY3Rpb25zXG4gICAgICAgICAgY29uc3QgYXV0aFByb3ZpZGVyID1cbiAgICAgICAgICAgIHJlcS5ib2R5ICYmXG4gICAgICAgICAgICByZXEuYm9keS5hdXRoRGF0YSAmJlxuICAgICAgICAgICAgT2JqZWN0LmtleXMocmVxLmJvZHkuYXV0aERhdGEpLmxlbmd0aCAmJlxuICAgICAgICAgICAgT2JqZWN0LmtleXMocmVxLmJvZHkuYXV0aERhdGEpLmpvaW4oJywnKTtcbiAgICAgICAgICBjb25zdCByZXF1ZXN0ID0ge1xuICAgICAgICAgICAgbWFzdGVyOiByZXEuYXV0aC5pc01hc3RlcixcbiAgICAgICAgICAgIGlwOiByZXEuY29uZmlnLmlwLFxuICAgICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHJlcS5hdXRoLmluc3RhbGxhdGlvbklkLFxuICAgICAgICAgICAgb2JqZWN0OiBQYXJzZS5Vc2VyLmZyb21KU09OKE9iamVjdC5hc3NpZ24oeyBjbGFzc05hbWU6ICdfVXNlcicgfSwgdXNlcikpLFxuICAgICAgICAgICAgY3JlYXRlZFdpdGg6IFJlc3RXcml0ZS5idWlsZENyZWF0ZWRXaXRoKCdsb2dpbicsIGF1dGhQcm92aWRlciksXG4gICAgICAgICAgfTtcblxuICAgICAgICAgIC8vIElmIHJlcXVlc3QgZG9lc24ndCB1c2UgbWFzdGVyIG9yIG1haW50ZW5hbmNlIGtleSB3aXRoIGlnbm9yaW5nIGVtYWlsIHZlcmlmaWNhdGlvblxuICAgICAgICAgIGlmICghKChyZXEuYXV0aC5pc01hc3RlciB8fCByZXEuYXV0aC5pc01haW50ZW5hbmNlKSAmJiBpZ25vcmVFbWFpbFZlcmlmaWNhdGlvbikpIHtcblxuICAgICAgICAgICAgLy8gR2V0IHZlcmlmaWNhdGlvbiBjb25kaXRpb25zIHdoaWNoIGNhbiBiZSBib29sZWFucyBvciBmdW5jdGlvbnM7IHRoZSBwdXJwb3NlIG9mIHRoaXMgYXN5bmMvYXdhaXRcbiAgICAgICAgICAgIC8vIHN0cnVjdHVyZSBpcyB0byBhdm9pZCB1bm5lY2Vzc2FyaWx5IGV4ZWN1dGluZyBzdWJzZXF1ZW50IGZ1bmN0aW9ucyBpZiBwcmV2aW91cyBvbmVzIGZhaWwgaW4gdGhlXG4gICAgICAgICAgICAvLyBjb25kaXRpb25hbCBzdGF0ZW1lbnQgYmVsb3csIGFzIGEgZGV2ZWxvcGVyIG1heSBkZWNpZGUgdG8gZXhlY3V0ZSBleHBlbnNpdmUgb3BlcmF0aW9ucyBpbiB0aGVtXG4gICAgICAgICAgICBjb25zdCB2ZXJpZnlVc2VyRW1haWxzID0gYXN5bmMgKCkgPT4gcmVxLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzID09PSB0cnVlIHx8ICh0eXBlb2YgcmVxLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzID09PSAnZnVuY3Rpb24nICYmIGF3YWl0IFByb21pc2UucmVzb2x2ZShyZXEuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHMocmVxdWVzdCkpID09PSB0cnVlKTtcbiAgICAgICAgICAgIGNvbnN0IHByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPSBhc3luYyAoKSA9PiByZXEuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPT09IHRydWUgfHwgKHR5cGVvZiByZXEuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPT09ICdmdW5jdGlvbicgJiYgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKHJlcS5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbChyZXF1ZXN0KSkgPT09IHRydWUpO1xuICAgICAgICAgICAgaWYgKGF3YWl0IHZlcmlmeVVzZXJFbWFpbHMoKSAmJiBhd2FpdCBwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsKCkgJiYgIXVzZXIuZW1haWxWZXJpZmllZCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRU1BSUxfTk9UX0ZPVU5ELCAnVXNlciBlbWFpbCBpcyBub3QgdmVyaWZpZWQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdGhpcy5fc2FuaXRpemVBdXRoRGF0YSh1c2VyKTtcblxuICAgICAgICAgIHJldHVybiByZXNvbHZlKHVzZXIpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIHJldHVybiByZWplY3QoZXJyb3IpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGhhbmRsZU1lKHJlcSkge1xuICAgIGlmICghcmVxLmluZm8gfHwgIXJlcS5pbmZvLnNlc3Npb25Ub2tlbikge1xuICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLCAnSW52YWxpZCBzZXNzaW9uIHRva2VuJywgcmVxLmNvbmZpZyk7XG4gICAgfVxuICAgIGNvbnN0IHNlc3Npb25Ub2tlbiA9IHJlcS5pbmZvLnNlc3Npb25Ub2tlbjtcbiAgICAvLyBRdWVyeSB0aGUgc2Vzc2lvbiB3aXRoIG1hc3RlciBrZXkgdG8gdmFsaWRhdGUgdGhlIHNlc3Npb24gdG9rZW4sXG4gICAgLy8gYnV0IGRvIE5PVCBpbmNsdWRlICd1c2VyJyB0byBhdm9pZCBsZWFraW5nIHVzZXIgZGF0YSB2aWEgbWFzdGVyIGNvbnRleHRcbiAgICBjb25zdCBzZXNzaW9uUmVzcG9uc2UgPSBhd2FpdCByZXN0LmZpbmQoXG4gICAgICByZXEuY29uZmlnLFxuICAgICAgQXV0aC5tYXN0ZXIocmVxLmNvbmZpZyksXG4gICAgICAnX1Nlc3Npb24nLFxuICAgICAgeyBzZXNzaW9uVG9rZW4gfSxcbiAgICAgIHt9LFxuICAgICAgcmVxLmluZm8uY29udGV4dFxuICAgICk7XG4gICAgaWYgKFxuICAgICAgIXNlc3Npb25SZXNwb25zZS5yZXN1bHRzIHx8XG4gICAgICBzZXNzaW9uUmVzcG9uc2UucmVzdWx0cy5sZW5ndGggPT0gMCB8fFxuICAgICAgIXNlc3Npb25SZXNwb25zZS5yZXN1bHRzWzBdLnVzZXJcbiAgICApIHtcbiAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTiwgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbicsIHJlcS5jb25maWcpO1xuICAgIH1cbiAgICBjb25zdCB1c2VySWQgPSBzZXNzaW9uUmVzcG9uc2UucmVzdWx0c1swXS51c2VyLm9iamVjdElkO1xuICAgIC8vIFJlLWZldGNoIHRoZSB1c2VyIHdpdGggdGhlIGNhbGxlcidzIGF1dGggY29udGV4dCBzbyB0aGF0XG4gICAgLy8gcHJvdGVjdGVkRmllbGRzLCBDTFAsIGFuZCBhdXRoIGFkYXB0ZXIgYWZ0ZXJGaW5kIGFwcGx5IGNvcnJlY3RseVxuICAgIGNvbnN0IHVzZXJSZXNwb25zZSA9IGF3YWl0IHJlc3QuZ2V0KFxuICAgICAgcmVxLmNvbmZpZyxcbiAgICAgIHJlcS5hdXRoLFxuICAgICAgJ19Vc2VyJyxcbiAgICAgIHVzZXJJZCxcbiAgICAgIHt9LFxuICAgICAgcmVxLmluZm8uY29udGV4dFxuICAgICk7XG4gICAgaWYgKCF1c2VyUmVzcG9uc2UucmVzdWx0cyB8fCB1c2VyUmVzcG9uc2UucmVzdWx0cy5sZW5ndGggPT0gMCkge1xuICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLCAnSW52YWxpZCBzZXNzaW9uIHRva2VuJywgcmVxLmNvbmZpZyk7XG4gICAgfVxuICAgIGNvbnN0IHVzZXIgPSB1c2VyUmVzcG9uc2UucmVzdWx0c1swXTtcbiAgICAvLyBTZW5kIHRva2VuIGJhY2sgb24gdGhlIGxvZ2luLCBiZWNhdXNlIFNES3MgZXhwZWN0IHRoYXQuXG4gICAgdXNlci5zZXNzaW9uVG9rZW4gPSBzZXNzaW9uVG9rZW47XG4gICAgLy8gUmVtb3ZlIGhpZGRlbiBwcm9wZXJ0aWVzLlxuICAgIFVzZXJzUm91dGVyLnJlbW92ZUhpZGRlblByb3BlcnRpZXModXNlcik7XG4gICAgcmV0dXJuIHsgcmVzcG9uc2U6IHVzZXIgfTtcbiAgfVxuXG4gIGFzeW5jIGhhbmRsZUxvZ0luKHJlcSkge1xuICAgIGNvbnN0IHVzZXIgPSBhd2FpdCB0aGlzLl9hdXRoZW50aWNhdGVVc2VyRnJvbVJlcXVlc3QocmVxKTtcbiAgICBjb25zdCBhdXRoRGF0YSA9IHJlcS5ib2R5ICYmIHJlcS5ib2R5LmF1dGhEYXRhO1xuICAgIC8vIENoZWNrIGlmIHVzZXIgaGFzIHByb3ZpZGVkIHRoZWlyIHJlcXVpcmVkIGF1dGggcHJvdmlkZXJzXG4gICAgQXV0aC5jaGVja0lmVXNlckhhc1Byb3ZpZGVkQ29uZmlndXJlZFByb3ZpZGVyc0ZvckxvZ2luKFxuICAgICAgcmVxLFxuICAgICAgYXV0aERhdGEsXG4gICAgICB1c2VyLmF1dGhEYXRhLFxuICAgICAgcmVxLmNvbmZpZ1xuICAgICk7XG5cbiAgICBsZXQgYXV0aERhdGFSZXNwb25zZTtcbiAgICBsZXQgdmFsaWRhdGVkQXV0aERhdGE7XG4gICAgaWYgKGF1dGhEYXRhKSB7XG4gICAgICAvLyBSdW4gdGhlIGFkYXB0ZXJzJyBgYmVmb3JlRmluZGAgKHRoZSBjcmVkZW50aWFsIGNoZWNrIGZvciBjb2RlLWJhc2VkIGFkYXB0ZXJzKSBhcyB0aGVcbiAgICAgIC8vIHNpZ251cC9saW5rIHBhdGggZG9lcywgYW5kIHJlamVjdCBhbiBpZGVudGl0eSBhbHJlYWR5IGxpbmtlZCB0byBhbm90aGVyIHVzZXJcbiAgICAgIGNvbnN0IGxpbmtlZFVzZXJzID0gYXdhaXQgQXV0aC5maW5kVXNlcnNXaXRoQXV0aERhdGEoXG4gICAgICAgIHJlcS5jb25maWcsXG4gICAgICAgIGF1dGhEYXRhLFxuICAgICAgICB0cnVlLFxuICAgICAgICB1c2VyLmF1dGhEYXRhXG4gICAgICApO1xuICAgICAgaWYgKGxpbmtlZFVzZXJzLnNvbWUobGlua2VkVXNlciA9PiBsaW5rZWRVc2VyLm9iamVjdElkICE9PSB1c2VyLm9iamVjdElkKSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuQUNDT1VOVF9BTFJFQURZX0xJTktFRCwgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IEF1dGguaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKFxuICAgICAgICBhdXRoRGF0YSxcbiAgICAgICAgbmV3IFJlc3RXcml0ZShcbiAgICAgICAgICByZXEuY29uZmlnLFxuICAgICAgICAgIHJlcS5hdXRoLFxuICAgICAgICAgICdfVXNlcicsXG4gICAgICAgICAgeyBvYmplY3RJZDogdXNlci5vYmplY3RJZCB9LFxuICAgICAgICAgIHJlcS5ib2R5IHx8IHt9LFxuICAgICAgICAgIHVzZXIsXG4gICAgICAgICAgcmVxLmluZm8uY29udGV4dFxuICAgICAgICApLFxuICAgICAgICB1c2VyXG4gICAgICApO1xuICAgICAgYXV0aERhdGFSZXNwb25zZSA9IHJlcy5hdXRoRGF0YVJlc3BvbnNlO1xuICAgICAgdmFsaWRhdGVkQXV0aERhdGEgPSByZXMuYXV0aERhdGE7XG4gICAgfVxuXG4gICAgLy8gaGFuZGxlIHBhc3N3b3JkIGV4cGlyeSBwb2xpY3lcbiAgICBpZiAocmVxLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJiByZXEuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlKSB7XG4gICAgICBsZXQgY2hhbmdlZEF0ID0gdXNlci5fcGFzc3dvcmRfY2hhbmdlZF9hdDtcblxuICAgICAgaWYgKCFjaGFuZ2VkQXQpIHtcbiAgICAgICAgLy8gcGFzc3dvcmQgd2FzIGNyZWF0ZWQgYmVmb3JlIGV4cGlyeSBwb2xpY3kgd2FzIGVuYWJsZWQuXG4gICAgICAgIC8vIHNpbXBseSB1cGRhdGUgX1VzZXIgb2JqZWN0IHNvIHRoYXQgaXQgd2lsbCBzdGFydCBlbmZvcmNpbmcgZnJvbSBub3dcbiAgICAgICAgY2hhbmdlZEF0ID0gbmV3IERhdGUoKTtcbiAgICAgICAgcmVxLmNvbmZpZy5kYXRhYmFzZS51cGRhdGUoXG4gICAgICAgICAgJ19Vc2VyJyxcbiAgICAgICAgICB7IHVzZXJuYW1lOiB1c2VyLnVzZXJuYW1lIH0sXG4gICAgICAgICAgeyBfcGFzc3dvcmRfY2hhbmdlZF9hdDogUGFyc2UuX2VuY29kZShjaGFuZ2VkQXQpIH1cbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIGNoZWNrIHdoZXRoZXIgdGhlIHBhc3N3b3JkIGhhcyBleHBpcmVkXG4gICAgICAgIGlmIChjaGFuZ2VkQXQuX190eXBlID09ICdEYXRlJykge1xuICAgICAgICAgIGNoYW5nZWRBdCA9IG5ldyBEYXRlKGNoYW5nZWRBdC5pc28pO1xuICAgICAgICB9XG4gICAgICAgIC8vIENhbGN1bGF0ZSB0aGUgZXhwaXJ5IHRpbWUuXG4gICAgICAgIGNvbnN0IGV4cGlyZXNBdCA9IG5ldyBEYXRlKFxuICAgICAgICAgIGNoYW5nZWRBdC5nZXRUaW1lKCkgKyA4NjQwMDAwMCAqIHJlcS5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2VcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGV4cGlyZXNBdCA8IG5ldyBEYXRlKCkpXG4gICAgICAgIC8vIGZhaWwgb2YgY3VycmVudCB0aW1lIGlzIHBhc3QgcGFzc3dvcmQgZXhwaXJ5IHRpbWVcbiAgICAgICAgeyB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAnWW91ciBwYXNzd29yZCBoYXMgZXhwaXJlZC4gUGxlYXNlIHJlc2V0IHlvdXIgcGFzc3dvcmQuJ1xuICAgICAgICApOyB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmVtb3ZlIGhpZGRlbiBwcm9wZXJ0aWVzLlxuICAgIFVzZXJzUm91dGVyLnJlbW92ZUhpZGRlblByb3BlcnRpZXModXNlcik7XG5cbiAgICBhd2FpdCByZXEuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHJlcS5jb25maWcsIHVzZXIpO1xuXG4gICAgLy8gQmVmb3JlIGxvZ2luIHRyaWdnZXI7IHRocm93cyBpZiBmYWlsdXJlXG4gICAgYXdhaXQgbWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgVHJpZ2dlclR5cGVzLmJlZm9yZUxvZ2luLFxuICAgICAgcmVxLmF1dGgsXG4gICAgICBQYXJzZS5Vc2VyLmZyb21KU09OKE9iamVjdC5hc3NpZ24oeyBjbGFzc05hbWU6ICdfVXNlcicgfSwgdXNlcikpLFxuICAgICAgbnVsbCxcbiAgICAgIHJlcS5jb25maWcsXG4gICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgKTtcblxuICAgIC8vIElmIHdlIGhhdmUgc29tZSBuZXcgdmFsaWRhdGVkIGF1dGhEYXRhIHVwZGF0ZSBkaXJlY3RseVxuICAgIGlmICh2YWxpZGF0ZWRBdXRoRGF0YSAmJiBPYmplY3Qua2V5cyh2YWxpZGF0ZWRBdXRoRGF0YSkubGVuZ3RoKSB7XG4gICAgICBjb25zdCBxdWVyeSA9IHsgb2JqZWN0SWQ6IHVzZXIub2JqZWN0SWQgfTtcbiAgICAgIC8vIFByZXZlbnQgY29uY3VycmVudCByZXF1ZXN0cyBmcm9tIGJvdGggc3VjY2VlZGluZyB3aGVuIGNvbnN1bWluZyBzaW5nbGUtdXNlXG4gICAgICAvLyB0b2tlbnMgKGUuZy4gTUZBIHJlY292ZXJ5IGNvZGVzIG9yIFNNUyBPVFAgdG9rZW5zKSBieSBleHRlbmRpbmcgdGhlIHVwZGF0ZVxuICAgICAgLy8gV0hFUkUgY2xhdXNlIHdpdGggdGhlIG9yaWdpbmFsIHZhbHVlcyBvZiBjaGFuZ2VkIHByaW1pdGl2ZS9hcnJheSBmaWVsZHMuXG4gICAgICBhcHBseUF1dGhEYXRhT3B0aW1pc3RpY0xvY2socXVlcnksIHVzZXIuYXV0aERhdGEsIHZhbGlkYXRlZEF1dGhEYXRhKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHJlcS5jb25maWcuZGF0YWJhc2UudXBkYXRlKCdfVXNlcicsIHF1ZXJ5LCB7IGF1dGhEYXRhOiB2YWxpZGF0ZWRBdXRoRGF0YSB9LCB7fSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELCAnSW52YWxpZCBhdXRoIGRhdGEnKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCB7IHNlc3Npb25EYXRhLCBjcmVhdGVTZXNzaW9uIH0gPSBSZXN0V3JpdGUuY3JlYXRlU2Vzc2lvbihyZXEuY29uZmlnLCB7XG4gICAgICB1c2VySWQ6IHVzZXIub2JqZWN0SWQsXG4gICAgICBjcmVhdGVkV2l0aDogUmVzdFdyaXRlLmJ1aWxkQ3JlYXRlZFdpdGgoJ2xvZ2luJyksXG4gICAgICBpbnN0YWxsYXRpb25JZDogcmVxLmluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgfSk7XG5cbiAgICB1c2VyLnNlc3Npb25Ub2tlbiA9IHNlc3Npb25EYXRhLnNlc3Npb25Ub2tlbjtcblxuICAgIGF3YWl0IGNyZWF0ZVNlc3Npb24oKTtcblxuICAgIGNvbnN0IGFmdGVyTG9naW5Vc2VyID0gUGFyc2UuVXNlci5mcm9tSlNPTihPYmplY3QuYXNzaWduKHsgY2xhc3NOYW1lOiAnX1VzZXInIH0sIHVzZXIpKTtcbiAgICBhd2FpdCBtYXliZVJ1blRyaWdnZXIoXG4gICAgICBUcmlnZ2VyVHlwZXMuYWZ0ZXJMb2dpbixcbiAgICAgIHsgLi4ucmVxLmF1dGgsIHVzZXI6IGFmdGVyTG9naW5Vc2VyIH0sXG4gICAgICBhZnRlckxvZ2luVXNlcixcbiAgICAgIG51bGwsXG4gICAgICByZXEuY29uZmlnLFxuICAgICAgcmVxLmluZm8uY29udGV4dFxuICAgICk7XG5cbiAgICAvLyBSZS1mZXRjaCB0aGUgdXNlciB3aXRoIHRoZSBjYWxsZXIncyBhdXRoIGNvbnRleHQgc28gdGhhdFxuICAgIC8vIHByb3RlY3RlZEZpZWxkcyBhbmQgQ0xQIGFwcGx5IGNvcnJlY3RseTsgaWYgdGhlIGNhbGxlciB1c2VkIG1hc3RlciBrZXksXG4gICAgLy8gcHJvdGVjdGVkRmllbGRzIGFyZSBieXBhc3NlZCwgbWF0Y2hpbmcgdGhlIGJlaGF2aW9yIG9mIEdFVCAvdXNlcnMvOmlkXG4gICAgY29uc3QgcmVmZXRjaEF1dGggPVxuICAgICAgcmVxLmF1dGguaXNNYXN0ZXIgfHwgcmVxLmF1dGguaXNNYWludGVuYW5jZVxuICAgICAgICA/IHJlcS5hdXRoXG4gICAgICAgIDogbmV3IEF1dGguQXV0aCh7XG4gICAgICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgICAgIGlzTWFzdGVyOiBmYWxzZSxcbiAgICAgICAgICB1c2VyOiBQYXJzZS5PYmplY3QuZnJvbUpTT04oeyBjbGFzc05hbWU6ICdfVXNlcicsIG9iamVjdElkOiB1c2VyLm9iamVjdElkIH0pLFxuICAgICAgICAgIGluc3RhbGxhdGlvbklkOiByZXEuaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgfSk7XG4gICAgbGV0IGZpbHRlcmVkVXNlcjtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZmlsdGVyZWRVc2VyUmVzcG9uc2UgPSBhd2FpdCByZXN0LmdldChcbiAgICAgICAgcmVxLmNvbmZpZyxcbiAgICAgICAgcmVmZXRjaEF1dGgsXG4gICAgICAgICdfVXNlcicsXG4gICAgICAgIHVzZXIub2JqZWN0SWQsXG4gICAgICAgIHt9LFxuICAgICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgICApO1xuICAgICAgZmlsdGVyZWRVc2VyID0gZmlsdGVyZWRVc2VyUmVzcG9uc2UucmVzdWx0cz8uWzBdO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gVGhlIHJlLWZldGNoIGVuZm9yY2VzIGBfVXNlcmAgYGdldGAgQ0xQIGFuZCBtYXkgYmUgZGVuaWVkIGJ5IGFjY2Vzc1xuICAgICAgLy8gY29udHJvbCAoZS5nLiBDTFAgYGdldDoge31gIG9yIGFuIEFDTCB0aGF0IGV4Y2x1ZGVzIHRoZSBjYWxsZXIpLlxuICAgICAgLy8gSGFuZGxlZCBiZWxvdzsgbmV2ZXIgZmFsbCBiYWNrIHRvIHRoZSByYXcgcm93LlxuICAgIH1cbiAgICBpZiAoIWZpbHRlcmVkVXNlcikge1xuICAgICAgLy8gTWFzdGVyL21haW50ZW5hbmNlIGNhbGxlcnMgYnlwYXNzIENMUCwgcHJvdGVjdGVkRmllbGRzLCBhbmQgYXV0aERhdGFcbiAgICAgIC8vIGFmdGVyRmluZCwgc28gZm9yIHRoZW0gYW4gZW1wdHkgcmUtZmV0Y2ggaXMgYSBnZW51aW5lIG5vdC1mb3VuZCBlZGdlLCBub3RcbiAgICAgIC8vIGFuIGFjY2Vzcy1jb250cm9sIGRlbmlhbDsgdGhleSBhcmUgZW50aXRsZWQgdG8gdGhlIGZ1bGwgcm93LiBGb3IgZXZlcnlcbiAgICAgIC8vIG90aGVyIGNhbGxlciwgYW4gZW1wdHkvZGVuaWVkIHJlLWZldGNoIG1lYW5zIGFjY2VzcyBjb250cm9sIHdpdGhoZWxkIHRoZVxuICAgICAgLy8gcmVjb3JkLCBzbyBkaXNjbG9zZSBvbmx5IHRoZSBpZGVudGl0eSDigJQgbmV2ZXIgdGhlIHJhdyByb3csIHdoaWNoIHdvdWxkXG4gICAgICAvLyBsZWFrIGZpZWxkcyBoaWRkZW4gYnkgYHByb3RlY3RlZEZpZWxkc2AgYW5kIHJhdyBgYXV0aERhdGFgIChlLmcuIE1GQVxuICAgICAgLy8gc2VjcmV0cyBhbmQgcmVjb3ZlcnkgY29kZXMpIHRoYXQgdGhlIHNhbml0aXppbmcgcmUtZmV0Y2ggd291bGQgcmVtb3ZlLlxuICAgICAgLy8gVGhlIHNlc3Npb24gdG9rZW4gaXMgc3RpbGwgYXR0YWNoZWQgYmVsb3cgc28gbG9naW4gc3VjY2VlZHMuXG4gICAgICBmaWx0ZXJlZFVzZXIgPVxuICAgICAgICByZXEuYXV0aC5pc01hc3RlciB8fCByZXEuYXV0aC5pc01haW50ZW5hbmNlID8gdXNlciA6IHsgb2JqZWN0SWQ6IHVzZXIub2JqZWN0SWQgfTtcbiAgICB9XG4gICAgVXNlcnNSb3V0ZXIucmVtb3ZlSGlkZGVuUHJvcGVydGllcyhmaWx0ZXJlZFVzZXIpO1xuICAgIGZpbHRlcmVkVXNlci5zZXNzaW9uVG9rZW4gPSB1c2VyLnNlc3Npb25Ub2tlbjtcbiAgICBpZiAoYXV0aERhdGFSZXNwb25zZSkge1xuICAgICAgZmlsdGVyZWRVc2VyLmF1dGhEYXRhUmVzcG9uc2UgPSBhdXRoRGF0YVJlc3BvbnNlO1xuICAgIH1cblxuICAgIHJldHVybiB7IHJlc3BvbnNlOiBmaWx0ZXJlZFVzZXIgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGlzIGFsbG93cyBtYXN0ZXIta2V5IGNsaWVudHMgdG8gY3JlYXRlIHVzZXIgc2Vzc2lvbnMgd2l0aG91dCBhY2Nlc3MgdG9cbiAgICogdXNlciBjcmVkZW50aWFscy4gVGhpcyBlbmFibGVzIHN5c3RlbXMgdGhhdCBjYW4gYXV0aGVudGljYXRlIGFjY2VzcyBhbm90aGVyXG4gICAqIHdheSAoQVBJIGtleSwgYXBwIGFkbWluaXN0cmF0b3JzKSB0byBhY3Qgb24gYSB1c2VyJ3MgYmVoYWxmLlxuICAgKlxuICAgKiBXZSBjcmVhdGUgYSBuZXcgc2Vzc2lvbiByYXRoZXIgdGhhbiBsb29raW5nIGZvciBhbiBleGlzdGluZyBzZXNzaW9uOyB3ZVxuICAgKiB3YW50IHRoaXMgdG8gd29yayBpbiBzaXR1YXRpb25zIHdoZXJlIHRoZSB1c2VyIGlzIGxvZ2dlZCBvdXQgb24gYWxsXG4gICAqIGRldmljZXMsIHNpbmNlIHRoaXMgY2FuIGJlIHVzZWQgYnkgYXV0b21hdGVkIHN5c3RlbXMgYWN0aW5nIG9uIHRoZSB1c2VyJ3NcbiAgICogYmVoYWxmLlxuICAgKlxuICAgKiBGb3IgdGhlIG1vbWVudCwgd2UncmUgb21pdHRpbmcgZXZlbnQgaG9va3MgYW5kIGxvY2tvdXQgY2hlY2tzLCBzaW5jZVxuICAgKiBpbW1lZGlhdGUgdXNlIGNhc2VzIHN1Z2dlc3QgL2xvZ2luQXMgY291bGQgYmUgdXNlZCBmb3Igc2VtYW50aWNhbGx5XG4gICAqIGRpZmZlcmVudCByZWFzb25zIGZyb20gL2xvZ2luXG4gICAqL1xuICBhc3luYyBoYW5kbGVMb2dJbkFzKHJlcSkge1xuICAgIGlmICghcmVxLmF1dGguaXNNYXN0ZXIpIHtcbiAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAnbWFzdGVyIGtleSBpcyByZXF1aXJlZCcsXG4gICAgICAgIHJlcS5jb25maWdcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChyZXEuYXV0aC5pc1JlYWRPbmx5KSB7XG4gICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgXCJyZWFkLW9ubHkgbWFzdGVyS2V5IGlzbid0IGFsbG93ZWQgdG8gbG9naW4gYXMgYW5vdGhlciB1c2VyLlwiLFxuICAgICAgICByZXEuY29uZmlnXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHVzZXJJZCA9IHJlcS5ib2R5Py51c2VySWQgfHwgcmVxLnF1ZXJ5LnVzZXJJZDtcbiAgICBpZiAoIXVzZXJJZCkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1ZBTFVFLFxuICAgICAgICAndXNlcklkIG11c3Qgbm90IGJlIGVtcHR5LCBudWxsLCBvciB1bmRlZmluZWQnXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHF1ZXJ5UmVzdWx0cyA9IGF3YWl0IHJlcS5jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCB7IG9iamVjdElkOiB1c2VySWQgfSk7XG4gICAgY29uc3QgdXNlciA9IHF1ZXJ5UmVzdWx0c1swXTtcbiAgICBpZiAoIXVzZXIpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAndXNlciBub3QgZm91bmQnKTtcbiAgICB9XG5cbiAgICB0aGlzLl9zYW5pdGl6ZUF1dGhEYXRhKHVzZXIpO1xuXG4gICAgY29uc3QgeyBzZXNzaW9uRGF0YSwgY3JlYXRlU2Vzc2lvbiB9ID0gUmVzdFdyaXRlLmNyZWF0ZVNlc3Npb24ocmVxLmNvbmZpZywge1xuICAgICAgdXNlcklkLFxuICAgICAgY3JlYXRlZFdpdGg6IFJlc3RXcml0ZS5idWlsZENyZWF0ZWRXaXRoKCdsb2dpbicsICdtYXN0ZXJrZXknKSxcbiAgICAgIGluc3RhbGxhdGlvbklkOiByZXEuaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICB9KTtcblxuICAgIHVzZXIuc2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuXG4gICAgYXdhaXQgY3JlYXRlU2Vzc2lvbigpO1xuXG4gICAgcmV0dXJuIHsgcmVzcG9uc2U6IHVzZXIgfTtcbiAgfVxuXG4gIGhhbmRsZVZlcmlmeVBhc3N3b3JkKHJlcSkge1xuICAgIHJldHVybiB0aGlzLl9hdXRoZW50aWNhdGVVc2VyRnJvbVJlcXVlc3QocmVxKVxuICAgICAgLnRoZW4oYXN5bmMgdXNlciA9PiB7XG4gICAgICAgIC8vIFJlbW92ZSBoaWRkZW4gcHJvcGVydGllcy5cbiAgICAgICAgVXNlcnNSb3V0ZXIucmVtb3ZlSGlkZGVuUHJvcGVydGllcyh1c2VyKTtcbiAgICAgICAgLy8gUmUtZmV0Y2ggdGhlIHVzZXIgd2l0aCB0aGUgY2FsbGVyJ3MgYXV0aCBjb250ZXh0IHNvIHRoYXRcbiAgICAgICAgLy8gcHJvdGVjdGVkRmllbGRzIGFuZCBDTFAgYXBwbHkgY29ycmVjdGx5OyBpZiB0aGUgY2FsbGVyIHVzZWQgbWFzdGVyIGtleSxcbiAgICAgICAgLy8gcHJvdGVjdGVkRmllbGRzIGFyZSBieXBhc3NlZCwgbWF0Y2hpbmcgdGhlIGJlaGF2aW9yIG9mIEdFVCAvdXNlcnMvOmlkXG4gICAgICAgIGNvbnN0IHJlZmV0Y2hBdXRoID1cbiAgICAgICAgICByZXEuYXV0aC5pc01hc3RlciB8fCByZXEuYXV0aC5pc01haW50ZW5hbmNlXG4gICAgICAgICAgICA/IHJlcS5hdXRoXG4gICAgICAgICAgICA6IG5ldyBBdXRoLkF1dGgoe1xuICAgICAgICAgICAgICBjb25maWc6IHJlcS5jb25maWcsXG4gICAgICAgICAgICAgIGlzTWFzdGVyOiBmYWxzZSxcbiAgICAgICAgICAgICAgdXNlcjogUGFyc2UuT2JqZWN0LmZyb21KU09OKHsgY2xhc3NOYW1lOiAnX1VzZXInLCBvYmplY3RJZDogdXNlci5vYmplY3RJZCB9KSxcbiAgICAgICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHJlcS5pbmZvLmluc3RhbGxhdGlvbklkLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIGxldCBmaWx0ZXJlZFVzZXI7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgZmlsdGVyZWRVc2VyUmVzcG9uc2UgPSBhd2FpdCByZXN0LmdldChcbiAgICAgICAgICAgIHJlcS5jb25maWcsXG4gICAgICAgICAgICByZWZldGNoQXV0aCxcbiAgICAgICAgICAgICdfVXNlcicsXG4gICAgICAgICAgICB1c2VyLm9iamVjdElkLFxuICAgICAgICAgICAge30sXG4gICAgICAgICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgICAgICAgKTtcbiAgICAgICAgICBmaWx0ZXJlZFVzZXIgPSBmaWx0ZXJlZFVzZXJSZXNwb25zZS5yZXN1bHRzPy5bMF07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8vIFRoZSByZS1mZXRjaCBlbmZvcmNlcyBgX1VzZXJgIGBnZXRgIENMUCBhbmQgbWF5IGJlIGRlbmllZCBieSBhY2Nlc3NcbiAgICAgICAgICAvLyBjb250cm9sIChlLmcuIENMUCBgZ2V0OiB7fWAgb3IgYW4gQUNMIHRoYXQgZXhjbHVkZXMgdGhlIGNhbGxlcikuXG4gICAgICAgICAgLy8gSGFuZGxlZCBiZWxvdzsgbmV2ZXIgZmFsbCBiYWNrIHRvIHRoZSByYXcgcm93LlxuICAgICAgICB9XG4gICAgICAgIGlmICghZmlsdGVyZWRVc2VyKSB7XG4gICAgICAgICAgLy8gU2VlIGhhbmRsZUxvZ0luOiBtYXN0ZXIvbWFpbnRlbmFuY2UgY2FsbGVycyBieXBhc3MgQ0xQLFxuICAgICAgICAgIC8vIHByb3RlY3RlZEZpZWxkcywgYW5kIGF1dGhEYXRhIGFmdGVyRmluZCwgc28gYW4gZW1wdHkgcmUtZmV0Y2ggaXMgYVxuICAgICAgICAgIC8vIGdlbnVpbmUgbm90LWZvdW5kIGVkZ2UgZm9yIHRoZW0gYW5kIHRoZXkgYXJlIGVudGl0bGVkIHRvIHRoZSBmdWxsXG4gICAgICAgICAgLy8gcm93LiBGb3IgYWxsIG90aGVyIGNhbGxlcnMsIGFuIGVtcHR5L2RlbmllZCByZS1mZXRjaCBtZWFucyBhY2Nlc3NcbiAgICAgICAgICAvLyBjb250cm9sIHdpdGhoZWxkIHRoZSByZWNvcmQsIHNvIGRpc2Nsb3NlIG9ubHkgdGhlIGlkZW50aXR5IHJhdGhlclxuICAgICAgICAgIC8vIHRoYW4gdGhlIHJhdyByb3csIHdoaWNoIHdvdWxkIGxlYWsgcHJvdGVjdGVkRmllbGRzIGFuZCByYXcgYXV0aERhdGFcbiAgICAgICAgICAvLyAoZS5nLiBNRkEgc2VjcmV0cyBhbmQgcmVjb3ZlcnkgY29kZXMpLlxuICAgICAgICAgIGZpbHRlcmVkVXNlciA9XG4gICAgICAgICAgICByZXEuYXV0aC5pc01hc3RlciB8fCByZXEuYXV0aC5pc01haW50ZW5hbmNlID8gdXNlciA6IHsgb2JqZWN0SWQ6IHVzZXIub2JqZWN0SWQgfTtcbiAgICAgICAgfVxuICAgICAgICBVc2Vyc1JvdXRlci5yZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzKGZpbHRlcmVkVXNlcik7XG4gICAgICAgIHJldHVybiB7IHJlc3BvbnNlOiBmaWx0ZXJlZFVzZXIgfTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgaGFuZGxlTG9nT3V0KHJlcSkge1xuICAgIGNvbnN0IHN1Y2Nlc3MgPSB7IHJlc3BvbnNlOiB7fSB9O1xuICAgIGlmIChyZXEuaW5mbyAmJiByZXEuaW5mby5zZXNzaW9uVG9rZW4pIHtcbiAgICAgIGNvbnN0IHJlY29yZHMgPSBhd2FpdCByZXN0LmZpbmQoXG4gICAgICAgIHJlcS5jb25maWcsXG4gICAgICAgIEF1dGgubWFzdGVyKHJlcS5jb25maWcpLFxuICAgICAgICAnX1Nlc3Npb24nLFxuICAgICAgICB7IHNlc3Npb25Ub2tlbjogcmVxLmluZm8uc2Vzc2lvblRva2VuIH0sXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgcmVxLmluZm8uY29udGV4dFxuICAgICAgKTtcbiAgICAgIGlmIChyZWNvcmRzLnJlc3VsdHMgJiYgcmVjb3Jkcy5yZXN1bHRzLmxlbmd0aCkge1xuICAgICAgICBhd2FpdCByZXN0LmRlbChcbiAgICAgICAgICByZXEuY29uZmlnLFxuICAgICAgICAgIEF1dGgubWFzdGVyKHJlcS5jb25maWcpLFxuICAgICAgICAgICdfU2Vzc2lvbicsXG4gICAgICAgICAgcmVjb3Jkcy5yZXN1bHRzWzBdLm9iamVjdElkLFxuICAgICAgICAgIHJlcS5pbmZvLmNvbnRleHRcbiAgICAgICAgKTtcbiAgICAgICAgYXdhaXQgbWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgICAgIFRyaWdnZXJUeXBlcy5hZnRlckxvZ291dCxcbiAgICAgICAgICByZXEuYXV0aCxcbiAgICAgICAgICBQYXJzZS5TZXNzaW9uLmZyb21KU09OKE9iamVjdC5hc3NpZ24oeyBjbGFzc05hbWU6ICdfU2Vzc2lvbicgfSwgcmVjb3Jkcy5yZXN1bHRzWzBdKSksXG4gICAgICAgICAgbnVsbCxcbiAgICAgICAgICByZXEuY29uZmlnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBzdWNjZXNzO1xuICB9XG5cbiAgX3Rocm93T25CYWRFbWFpbENvbmZpZyhyZXEpIHtcbiAgICB0cnkge1xuICAgICAgQ29uZmlnLnZhbGlkYXRlRW1haWxDb25maWd1cmF0aW9uKHtcbiAgICAgICAgZW1haWxBZGFwdGVyOiByZXEuY29uZmlnLnVzZXJDb250cm9sbGVyLmFkYXB0ZXIsXG4gICAgICAgIGFwcE5hbWU6IHJlcS5jb25maWcuYXBwTmFtZSxcbiAgICAgICAgcHVibGljU2VydmVyVVJMOiByZXEuY29uZmlnLnB1YmxpY1NlcnZlclVSTCB8fCByZXEuY29uZmlnLl9wdWJsaWNTZXJ2ZXJVUkwsXG4gICAgICAgIGVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uOiByZXEuY29uZmlnLmVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uLFxuICAgICAgICBlbWFpbFZlcmlmeVRva2VuUmV1c2VJZlZhbGlkOiByZXEuY29uZmlnLmVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAodHlwZW9mIGUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIC8vIE1heWJlIHdlIG5lZWQgYSBCYWQgQ29uZmlndXJhdGlvbiBlcnJvciwgYnV0IHRoZSBTREtzIHdvbid0IHVuZGVyc3RhbmQgaXQuIEZvciBub3csIEludGVybmFsIFNlcnZlciBFcnJvci5cbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUixcbiAgICAgICAgICAnQW4gYXBwTmFtZSwgcHVibGljU2VydmVyVVJMLCBhbmQgZW1haWxBZGFwdGVyIGFyZSByZXF1aXJlZCBmb3IgcGFzc3dvcmQgcmVzZXQgYW5kIGVtYWlsIHZlcmlmaWNhdGlvbiBmdW5jdGlvbmFsaXR5LidcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IGU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgaGFuZGxlUmVzZXRSZXF1ZXN0KHJlcSkge1xuICAgIHRoaXMuX3Rocm93T25CYWRFbWFpbENvbmZpZyhyZXEpO1xuXG4gICAgbGV0IGVtYWlsID0gcmVxLmJvZHk/LmVtYWlsO1xuICAgIGNvbnN0IHRva2VuID0gcmVxLmJvZHk/LnRva2VuO1xuXG4gICAgaWYgKCFlbWFpbCAmJiAhdG9rZW4pIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5FTUFJTF9NSVNTSU5HLCAneW91IG11c3QgcHJvdmlkZSBhbiBlbWFpbCcpO1xuICAgIH1cblxuICAgIGlmICh0b2tlbiAmJiB0eXBlb2YgdG9rZW4gIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9WQUxVRSwgJ3Rva2VuIG11c3QgYmUgYSBzdHJpbmcnKTtcbiAgICB9XG5cbiAgICBsZXQgdXNlclJlc3VsdHMgPSBudWxsO1xuICAgIGxldCB1c2VyRGF0YSA9IG51bGw7XG5cbiAgICAvLyBXZSBjYW4gZmluZCB0aGUgdXNlciB1c2luZyB0b2tlblxuICAgIGlmICh0b2tlbikge1xuICAgICAgdXNlclJlc3VsdHMgPSBhd2FpdCByZXEuY29uZmlnLmRhdGFiYXNlLmZpbmQoJ19Vc2VyJywge1xuICAgICAgICBfcGVyaXNoYWJsZV90b2tlbjogdG9rZW4sXG4gICAgICAgIF9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQ6IHsgJGx0OiBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKCkpIH0sXG4gICAgICB9KTtcbiAgICAgIGlmICh1c2VyUmVzdWx0cz8ubGVuZ3RoID4gMCkge1xuICAgICAgICB1c2VyRGF0YSA9IHVzZXJSZXN1bHRzWzBdO1xuICAgICAgICBpZiAodXNlckRhdGEuZW1haWwpIHtcbiAgICAgICAgICBlbWFpbCA9IHVzZXJEYXRhLmVtYWlsO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgLy8gT3IgdXNpbmcgZW1haWwgaWYgbm8gdG9rZW4gcHJvdmlkZWRcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBlbWFpbCA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHVzZXJSZXN1bHRzID0gYXdhaXQgcmVxLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAnX1VzZXInLFxuICAgICAgICB7ICRvcjogW3sgZW1haWwgfSwgeyB1c2VybmFtZTogZW1haWwsIGVtYWlsOiB7ICRleGlzdHM6IGZhbHNlIH0gfV0gfSxcbiAgICAgICAgeyBsaW1pdDogMSB9LFxuICAgICAgICBBdXRoLm1haW50ZW5hbmNlKHJlcS5jb25maWcpXG4gICAgICApO1xuICAgICAgaWYgKHVzZXJSZXN1bHRzPy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHVzZXJEYXRhID0gdXNlclJlc3VsdHNbMF07XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBlbWFpbCAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9FTUFJTF9BRERSRVNTLFxuICAgICAgICAneW91IG11c3QgcHJvdmlkZSBhIHZhbGlkIGVtYWlsIHN0cmluZydcbiAgICAgICk7XG4gICAgfVxuXG4gICAgaWYgKHVzZXJEYXRhKSB7XG4gICAgICB0aGlzLl9zYW5pdGl6ZUF1dGhEYXRhKHVzZXJEYXRhKTtcbiAgICAgIC8vIEdldCBmaWxlcyBhdHRhY2hlZCB0byB1c2VyXG4gICAgICBhd2FpdCByZXEuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHJlcS5jb25maWcsIHVzZXJEYXRhKTtcblxuICAgICAgY29uc3QgdXNlciA9IGluZmxhdGUoJ19Vc2VyJywgdXNlckRhdGEpO1xuXG4gICAgICBhd2FpdCBtYXliZVJ1blRyaWdnZXIoXG4gICAgICAgIFRyaWdnZXJUeXBlcy5iZWZvcmVQYXNzd29yZFJlc2V0UmVxdWVzdCxcbiAgICAgICAgcmVxLmF1dGgsXG4gICAgICAgIHVzZXIsXG4gICAgICAgIG51bGwsXG4gICAgICAgIHJlcS5jb25maWcsXG4gICAgICAgIHJlcS5pbmZvLmNvbnRleHRcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgdXNlckNvbnRyb2xsZXIgPSByZXEuY29uZmlnLnVzZXJDb250cm9sbGVyO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB1c2VyQ29udHJvbGxlci5zZW5kUGFzc3dvcmRSZXNldEVtYWlsKGVtYWlsKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHJlc3BvbnNlOiB7fSxcbiAgICAgIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoZXJyLmNvZGUgPT09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgaWYgKHJlcS5jb25maWcucGFzc3dvcmRQb2xpY3k/LnJlc2V0UGFzc3dvcmRTdWNjZXNzT25JbnZhbGlkRW1haWwgPz8gdHJ1ZSkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICByZXNwb25zZToge30sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBlcnIubWVzc2FnZSA9IGBBIHVzZXIgd2l0aCB0aGF0IGVtYWlsIGRvZXMgbm90IGV4aXN0LmA7XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgaGFuZGxlVmVyaWZpY2F0aW9uRW1haWxSZXF1ZXN0KHJlcSkge1xuICAgIHRoaXMuX3Rocm93T25CYWRFbWFpbENvbmZpZyhyZXEpO1xuXG4gICAgY29uc3QgeyBlbWFpbCB9ID0gcmVxLmJvZHkgfHwge307XG4gICAgaWYgKCFlbWFpbCkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX01JU1NJTkcsICd5b3UgbXVzdCBwcm92aWRlIGFuIGVtYWlsJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZW1haWwgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfRU1BSUxfQUREUkVTUyxcbiAgICAgICAgJ3lvdSBtdXN0IHByb3ZpZGUgYSB2YWxpZCBlbWFpbCBzdHJpbmcnXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHZlcmlmeUVtYWlsU3VjY2Vzc09uSW52YWxpZEVtYWlsID0gcmVxLmNvbmZpZy5lbWFpbFZlcmlmeVN1Y2Nlc3NPbkludmFsaWRFbWFpbCA/PyB0cnVlO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IHJlcS5jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCB7IGVtYWlsOiBlbWFpbCB9LCB7fSwgQXV0aC5tYWludGVuYW5jZShyZXEuY29uZmlnKSk7XG4gICAgaWYgKCFyZXN1bHRzLmxlbmd0aCB8fCByZXN1bHRzLmxlbmd0aCA8IDEpIHtcbiAgICAgIGlmICh2ZXJpZnlFbWFpbFN1Y2Nlc3NPbkludmFsaWRFbWFpbCkge1xuICAgICAgICByZXR1cm4geyByZXNwb25zZToge30gfTtcbiAgICAgIH1cbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5FTUFJTF9OT1RfRk9VTkQsIGBObyB1c2VyIGZvdW5kIHdpdGggZW1haWwgJHtlbWFpbH1gKTtcbiAgICB9XG4gICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG5cbiAgICAvLyByZW1vdmUgcGFzc3dvcmQgZmllbGQsIG1lc3NlcyB3aXRoIHNhdmluZyBvbiBwb3N0Z3Jlc1xuICAgIGRlbGV0ZSB1c2VyLnBhc3N3b3JkO1xuXG4gICAgaWYgKHVzZXIuZW1haWxWZXJpZmllZCkge1xuICAgICAgaWYgKHZlcmlmeUVtYWlsU3VjY2Vzc09uSW52YWxpZEVtYWlsKSB7XG4gICAgICAgIHJldHVybiB7IHJlc3BvbnNlOiB7fSB9O1xuICAgICAgfVxuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9USEVSX0NBVVNFLCBgRW1haWwgJHtlbWFpbH0gaXMgYWxyZWFkeSB2ZXJpZmllZC5gKTtcbiAgICB9XG5cbiAgICBjb25zdCB1c2VyQ29udHJvbGxlciA9IHJlcS5jb25maWcudXNlckNvbnRyb2xsZXI7XG4gICAgY29uc3Qgc2VuZCA9IGF3YWl0IHVzZXJDb250cm9sbGVyLnJlZ2VuZXJhdGVFbWFpbFZlcmlmeVRva2VuKHVzZXIsIHJlcS5hdXRoLmlzTWFzdGVyLCByZXEuYXV0aC5pbnN0YWxsYXRpb25JZCwgcmVxLmlwKTtcbiAgICBpZiAoc2VuZCkge1xuICAgICAgdXNlckNvbnRyb2xsZXIuc2VuZFZlcmlmaWNhdGlvbkVtYWlsKHVzZXIsIHJlcSk7XG4gICAgfVxuICAgIHJldHVybiB7IHJlc3BvbnNlOiB7fSB9O1xuICB9XG5cbiAgYXN5bmMgaGFuZGxlQ2hhbGxlbmdlKHJlcSkge1xuICAgIGNvbnN0IHsgdXNlcm5hbWUsIGVtYWlsLCBwYXNzd29yZCwgYXV0aERhdGEsIGNoYWxsZW5nZURhdGEgfSA9IHJlcS5ib2R5IHx8IHt9O1xuXG4gICAgLy8gaWYgdXNlcm5hbWUgb3IgZW1haWwgcHJvdmlkZWQgd2l0aCBwYXNzd29yZCB0cnkgdG8gYXV0aGVudGljYXRlIHRoZSB1c2VyIGJ5IHVzZXJuYW1lXG4gICAgbGV0IHVzZXI7XG4gICAgaWYgKHVzZXJuYW1lIHx8IGVtYWlsKSB7XG4gICAgICBpZiAoIXBhc3N3b3JkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5PVEhFUl9DQVVTRSxcbiAgICAgICAgICAnWW91IHByb3ZpZGVkIHVzZXJuYW1lIG9yIGVtYWlsLCB5b3UgbmVlZCB0byBhbHNvIHByb3ZpZGUgcGFzc3dvcmQuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgdXNlciA9IGF3YWl0IHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXJGcm9tUmVxdWVzdChyZXEpO1xuICAgIH1cblxuICAgIGlmICghY2hhbGxlbmdlRGF0YSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9USEVSX0NBVVNFLCAnTm90aGluZyB0byBjaGFsbGVuZ2UuJyk7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBjaGFsbGVuZ2VEYXRhICE9PSAnb2JqZWN0Jykge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9USEVSX0NBVVNFLCAnY2hhbGxlbmdlRGF0YSBzaG91bGQgYmUgYW4gb2JqZWN0LicpO1xuICAgIH1cblxuICAgIGxldCByZXF1ZXN0O1xuICAgIGxldCBwYXJzZVVzZXI7XG5cbiAgICAvLyBUcnkgdG8gZmluZCB1c2VyIGJ5IGF1dGhEYXRhXG4gICAgaWYgKGF1dGhEYXRhKSB7XG4gICAgICBpZiAodHlwZW9mIGF1dGhEYXRhICE9PSAnb2JqZWN0Jykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsICdhdXRoRGF0YSBzaG91bGQgYmUgYW4gb2JqZWN0LicpO1xuICAgICAgfVxuICAgICAgaWYgKHVzZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLk9USEVSX0NBVVNFLFxuICAgICAgICAgICdZb3UgY2Fubm90IHByb3ZpZGUgdXNlcm5hbWUvZW1haWwgYW5kIGF1dGhEYXRhLCBvbmx5IHVzZSBvbmUgaWRlbnRpZmljYXRpb24gbWV0aG9kLidcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoYXV0aERhdGEpKSB7XG4gICAgICAgIGlmIChhdXRoRGF0YVtrZXldICE9PSBudWxsICYmICh0eXBlb2YgYXV0aERhdGFba2V5XSAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShhdXRoRGF0YVtrZXldKSkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PVEhFUl9DQVVTRSxcbiAgICAgICAgICAgIGBhdXRoRGF0YS4ke2tleX0gc2hvdWxkIGJlIGFuIG9iamVjdC5gXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXMoYXV0aERhdGEpLmZpbHRlcihrZXkgPT4gYXV0aERhdGFba2V5XSAmJiBhdXRoRGF0YVtrZXldLmlkKS5sZW5ndGggPiAxKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5PVEhFUl9DQVVTRSxcbiAgICAgICAgICAnWW91IGNhbm5vdCBwcm92aWRlIG1vcmUgdGhhbiBvbmUgYXV0aERhdGEgcHJvdmlkZXIgd2l0aCBhbiBpZC4nXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIFJ1biBgYmVmb3JlRmluZGAgc28gYSBiYXJlIGNsaWVudC1zdXBwbGllZCBwcm92aWRlciBpZCBjYW5ub3Qgc2VsZWN0IHRoZSB1c2VyXG4gICAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBBdXRoLmZpbmRVc2Vyc1dpdGhBdXRoRGF0YShyZXEuY29uZmlnLCBhdXRoRGF0YSwgdHJ1ZSk7XG4gICAgICAgIGlmICghcmVzdWx0c1swXSB8fCByZXN1bHRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ1VzZXIgbm90IGZvdW5kLicpO1xuICAgICAgICB9XG4gICAgICAgIC8vIEZpbmQgdGhlIHByb3ZpZGVyIHVzZWQgdG8gZmluZCB0aGUgdXNlclxuICAgICAgICBjb25zdCBwcm92aWRlciA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKS5maW5kKGtleSA9PiBhdXRoRGF0YVtrZXldICYmIGF1dGhEYXRhW2tleV0uaWQpO1xuXG4gICAgICAgIHBhcnNlVXNlciA9IFBhcnNlLlVzZXIuZnJvbUpTT04oeyBjbGFzc05hbWU6ICdfVXNlcicsIC4uLnJlc3VsdHNbMF0gfSk7XG4gICAgICAgIHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KHVuZGVmaW5lZCwgcmVxLmF1dGgsIHBhcnNlVXNlciwgcGFyc2VVc2VyLCByZXEuY29uZmlnKTtcbiAgICAgICAgcmVxdWVzdC5pc0NoYWxsZW5nZSA9IHRydWU7XG4gICAgICAgIC8vIFZhbGlkYXRlIGF1dGhEYXRhIHVzZWQgdG8gaWRlbnRpZnkgdGhlIHVzZXIgdG8gYXZvaWQgYnJ1dGUtZm9yY2UgYXR0YWNrIG9uIGBpZGBcbiAgICAgICAgY29uc3QgeyB2YWxpZGF0b3IgfSA9IHJlcS5jb25maWcuYXV0aERhdGFNYW5hZ2VyLmdldFZhbGlkYXRvckZvclByb3ZpZGVyKHByb3ZpZGVyKTtcbiAgICAgICAgY29uc3QgdmFsaWRhdG9yUmVzcG9uc2UgPSBhd2FpdCB2YWxpZGF0b3IoYXV0aERhdGFbcHJvdmlkZXJdLCByZXEsIHBhcnNlVXNlciwgcmVxdWVzdCk7XG4gICAgICAgIGlmICh2YWxpZGF0b3JSZXNwb25zZSAmJiB2YWxpZGF0b3JSZXNwb25zZS52YWxpZGF0b3IpIHtcbiAgICAgICAgICBhd2FpdCB2YWxpZGF0b3JSZXNwb25zZS52YWxpZGF0b3IoKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyBSZXdyaXRlIHRoZSBlcnJvciB0byBhdm9pZCBndWVzcyBpZCBhdHRhY2tcbiAgICAgICAgbG9nZ2VyLmVycm9yKGUpO1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ1VzZXIgbm90IGZvdW5kLicpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghcGFyc2VVc2VyKSB7XG4gICAgICBwYXJzZVVzZXIgPSB1c2VyID8gUGFyc2UuVXNlci5mcm9tSlNPTih7IGNsYXNzTmFtZTogJ19Vc2VyJywgLi4udXNlciB9KSA6IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBpZiAoIXJlcXVlc3QpIHtcbiAgICAgIHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KHVuZGVmaW5lZCwgcmVxLmF1dGgsIHBhcnNlVXNlciwgcGFyc2VVc2VyLCByZXEuY29uZmlnKTtcbiAgICAgIHJlcXVlc3QuaXNDaGFsbGVuZ2UgPSB0cnVlO1xuICAgIH1cbiAgICBjb25zdCBhY2MgPSB7fTtcbiAgICAvLyBFeGVjdXRlIGNoYWxsZW5nZSBzdGVwLWJ5LXN0ZXAgd2l0aCBjb25zaXN0ZW50IG9yZGVyIGZvciBiZXR0ZXIgZXJyb3IgZmVlZGJhY2tcbiAgICAvLyBhbmQgdG8gYXZvaWQgdG8gdHJpZ2dlciBvdGhlcnMgY2hhbGxlbmdlcyBpZiBvbmUgb2YgdGhlbSBmYWlsc1xuICAgIGZvciAoY29uc3QgcHJvdmlkZXIgb2YgT2JqZWN0LmtleXMoY2hhbGxlbmdlRGF0YSkuc29ydCgpKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBhdXRoQWRhcHRlciA9IHJlcS5jb25maWcuYXV0aERhdGFNYW5hZ2VyLmdldFZhbGlkYXRvckZvclByb3ZpZGVyKHByb3ZpZGVyKTtcbiAgICAgICAgaWYgKCFhdXRoQWRhcHRlcikge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHtcbiAgICAgICAgICBhZGFwdGVyOiB7IGNoYWxsZW5nZSB9LFxuICAgICAgICB9ID0gYXV0aEFkYXB0ZXI7XG4gICAgICAgIGlmICh0eXBlb2YgY2hhbGxlbmdlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgY29uc3QgcHJvdmlkZXJDaGFsbGVuZ2VSZXNwb25zZSA9IGF3YWl0IGNoYWxsZW5nZShcbiAgICAgICAgICAgIGNoYWxsZW5nZURhdGFbcHJvdmlkZXJdLFxuICAgICAgICAgICAgYXV0aERhdGEgJiYgYXV0aERhdGFbcHJvdmlkZXJdLFxuICAgICAgICAgICAgcmVxLmNvbmZpZy5hdXRoW3Byb3ZpZGVyXSxcbiAgICAgICAgICAgIHJlcXVlc3RcbiAgICAgICAgICApO1xuICAgICAgICAgIGFjY1twcm92aWRlcl0gPSBwcm92aWRlckNoYWxsZW5nZVJlc3BvbnNlIHx8IHRydWU7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBlID0gcmVzb2x2ZUVycm9yKGVyciwge1xuICAgICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgICAgbWVzc2FnZTogJ0NoYWxsZW5nZSBmYWlsZWQuIFVua25vd24gZXJyb3IuJyxcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IHVzZXJTdHJpbmcgPSByZXEuYXV0aCAmJiByZXEuYXV0aC51c2VyID8gcmVxLmF1dGgudXNlci5pZCA6IHVuZGVmaW5lZDtcbiAgICAgICAgbG9nZ2VyLmVycm9yKFxuICAgICAgICAgIGBGYWlsZWQgcnVubmluZyBhdXRoIHN0ZXAgY2hhbGxlbmdlIGZvciAke3Byb3ZpZGVyfSBmb3IgdXNlciAke3VzZXJTdHJpbmd9IHdpdGggRXJyb3I6IGAgK1xuICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZSksXG4gICAgICAgICAge1xuICAgICAgICAgICAgYXV0aGVudGljYXRpb25TdGVwOiAnY2hhbGxlbmdlJyxcbiAgICAgICAgICAgIGVycm9yOiBlLFxuICAgICAgICAgICAgdXNlcjogdXNlclN0cmluZyxcbiAgICAgICAgICAgIHByb3ZpZGVyLFxuICAgICAgICAgIH1cbiAgICAgICAgKTtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHsgcmVzcG9uc2U6IHsgY2hhbGxlbmdlRGF0YTogYWNjIH0gfTtcbiAgfVxuXG4gIG1vdW50Um91dGVzKCkge1xuICAgIHRoaXMucm91dGUoJ0dFVCcsICcvdXNlcnMnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlRmluZChyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ1BPU1QnLCAnL3VzZXJzJywgcHJvbWlzZUVuc3VyZUlkZW1wb3RlbmN5LCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlQ3JlYXRlKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnR0VUJywgJy91c2Vycy9tZScsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVNZShyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ0dFVCcsICcvdXNlcnMvOm9iamVjdElkJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUdldChyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ1BVVCcsICcvdXNlcnMvOm9iamVjdElkJywgcHJvbWlzZUVuc3VyZUlkZW1wb3RlbmN5LCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlVXBkYXRlKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnREVMRVRFJywgJy91c2Vycy86b2JqZWN0SWQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlRGVsZXRlKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnR0VUJywgJy9sb2dpbicsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVMb2dJbihyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ1BPU1QnLCAnL2xvZ2luJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUxvZ0luKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvbG9naW5BcycsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVMb2dJbkFzKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvbG9nb3V0JywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUxvZ091dChyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ1BPU1QnLCAnL3JlcXVlc3RQYXNzd29yZFJlc2V0JywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZVJlc2V0UmVxdWVzdChyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ1BPU1QnLCAnL3ZlcmlmaWNhdGlvbkVtYWlsUmVxdWVzdCcsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVWZXJpZmljYXRpb25FbWFpbFJlcXVlc3QocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdHRVQnLCAnL3ZlcmlmeVBhc3N3b3JkJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZVZlcmlmeVBhc3N3b3JkKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvdmVyaWZ5UGFzc3dvcmQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlVmVyaWZ5UGFzc3dvcmQocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdQT1NUJywgJy9jaGFsbGVuZ2UnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlQ2hhbGxlbmdlKHJlcSk7XG4gICAgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgVXNlcnNSb3V0ZXI7XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUVBLElBQUFBLEtBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLE9BQUEsR0FBQUYsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFFLGVBQUEsR0FBQUgsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFHLGNBQUEsR0FBQUosc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFJLEtBQUEsR0FBQUwsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFLLEtBQUEsR0FBQU4sc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFNLFNBQUEsR0FBQVAsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFPLFNBQUEsR0FBQVAsT0FBQTtBQU9BLElBQUFRLFlBQUEsR0FBQVIsT0FBQTtBQUNBLElBQUFTLFVBQUEsR0FBQVYsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFVLE9BQUEsR0FBQVYsT0FBQTtBQUNBLElBQUFX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QUcsQ0FBQztJQUM5QixDQUFDLENBQUM7SUFDRixJQUFJLENBQUNvTCxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRXBMLEdBQUcsSUFBSTtNQUNsQyxPQUFPLElBQUksQ0FBQ3NFLFdBQVcsQ0FBQ3RFLEdBQUcsQ0FBQztJQUM5QixDQUFDLENBQUM7SUFDRixJQUFJLENBQUNvTCxLQUFLLENBQUMsTUFBTSxFQUFFLFVBQVUsRUFBRXBMLEdBQUcsSUFBSTtNQUNwQyxPQUFPLElBQUksQ0FBQzJHLGFBQWEsQ0FBQzNHLEdBQUcsQ0FBQztJQUNoQyxDQUFDLENBQUM7SUFDRixJQUFJLENBQUNvTCxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRXBMLEdBQUcsSUFBSTtNQUNuQyxPQUFPLElBQUksQ0FBQ2lILFlBQVksQ0FBQ2pILEdBQUcsQ0FBQztJQUMvQixDQUFDLENBQUM7SUFDRixJQUFJLENBQUNvTCxLQUFLLENBQUMsTUFBTSxFQUFFLHVCQUF1QixFQUFFcEwsR0FBRyxJQUFJO01BQ2pELE9BQU8sSUFBSSxDQUFDb0ksa0JBQWtCLENBQUNwSSxHQUFHLENBQUM7SUFDckMsQ0FBQyxDQUFDO0lBQ0YsSUFBSSxDQUFDb0wsS0FBSyxDQUFDLE1BQU0sRUFBRSwyQkFBMkIsRUFBRXBMLEdBQUcsSUFBSTtNQUNyRCxPQUFPLElBQUksQ0FBQ3FKLDhCQUE4QixDQUFDckosR0FBRyxDQUFDO0lBQ2pELENBQUMsQ0FBQztJQUNGLElBQUksQ0FBQ29MLEtBQUssQ0FBQyxLQUFLLEVBQUUsaUJBQWlCLEVBQUVwTCxHQUFHLElBQUk7TUFDMUMsT0FBTyxJQUFJLENBQUNnSCxvQkFBb0IsQ0FBQ2hILEdBQUcsQ0FBQztJQUN2QyxDQUFDLENBQUM7SUFDRixJQUFJLENBQUNvTCxLQUFLLENBQUMsTUFBTSxFQUFFLGlCQUFpQixFQUFFcEwsR0FBRyxJQUFJO01BQzNDLE9BQU8sSUFBSSxDQUFDZ0gsb0JBQW9CLENBQUNoSCxHQUFHLENBQUM7SUFDdkMsQ0FBQyxDQUFDO0lBQ0YsSUFBSSxDQUFDb0wsS0FBSyxDQUFDLE1BQU0sRUFBRSxZQUFZLEVBQUVwTCxHQUFHLElBQUk7TUFDdEMsT0FBTyxJQUFJLENBQUM0SixlQUFlLENBQUM1SixHQUFHLENBQUM7SUFDbEMsQ0FBQyxDQUFDO0VBQ0o7QUFDRjtBQUFDMkwsT0FBQSxDQUFBL00sV0FBQSxHQUFBQSxXQUFBO0FBQUEsSUFBQWdOLFFBQUEsR0FBQUQsT0FBQSxDQUFBaE4sT0FBQSxHQUVjQyxXQUFXIiwiaWdub3JlTGlzdCI6W119