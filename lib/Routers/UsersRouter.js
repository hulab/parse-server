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
      const results = await _Auth.default.findUsersWithAuthData(req.config, authData);
      try {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX0NvbmZpZyIsIl9BY2NvdW50TG9ja291dCIsIl9DbGFzc2VzUm91dGVyIiwiX3Jlc3QiLCJfQXV0aCIsIl9wYXNzd29yZCIsIl90cmlnZ2VycyIsIl9taWRkbGV3YXJlcyIsIl9SZXN0V3JpdGUiLCJfbG9nZ2VyIiwiX0Vycm9yIiwiX0F1dGhEYXRhTG9jayIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsIlVzZXJzUm91dGVyIiwiQ2xhc3Nlc1JvdXRlciIsImNsYXNzTmFtZSIsInJlbW92ZUhpZGRlblByb3BlcnRpZXMiLCJvYmoiLCJrZXkiLCJPYmplY3QiLCJwcm90b3R5cGUiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJ0ZXN0IiwiX3Nhbml0aXplQXV0aERhdGEiLCJ1c2VyIiwicGFzc3dvcmQiLCJhdXRoRGF0YSIsImtleXMiLCJmb3JFYWNoIiwicHJvdmlkZXIiLCJsZW5ndGgiLCJfYXV0aGVudGljYXRlVXNlckZyb21SZXF1ZXN0IiwicmVxIiwiUHJvbWlzZSIsInJlc29sdmUiLCJyZWplY3QiLCJwYXlsb2FkIiwiYm9keSIsInVzZXJuYW1lIiwicXVlcnkiLCJlbWFpbCIsImlnbm9yZUVtYWlsVmVyaWZpY2F0aW9uIiwiUGFyc2UiLCJFcnJvciIsIlVTRVJOQU1FX01JU1NJTkciLCJQQVNTV09SRF9NSVNTSU5HIiwiT0JKRUNUX05PVF9GT1VORCIsImlzVmFsaWRQYXNzd29yZCIsIiRvciIsImNvbmZpZyIsImRhdGFiYXNlIiwiZmluZCIsIkF1dGgiLCJtYWludGVuYW5jZSIsInRoZW4iLCJyZXN1bHRzIiwicGFzc3dvcmRDcnlwdG8iLCJjb21wYXJlIiwiZHVtbXlIYXNoIiwibG9nZ2VyQ29udHJvbGxlciIsIndhcm4iLCJmaWx0ZXIiLCJjb3JyZWN0IiwiYWNjb3VudExvY2tvdXRQb2xpY3kiLCJBY2NvdW50TG9ja291dCIsImhhbmRsZUxvZ2luQXR0ZW1wdCIsImF1dGgiLCJpc01hc3RlciIsIkFDTCIsImF1dGhQcm92aWRlciIsImpvaW4iLCJyZXF1ZXN0IiwibWFzdGVyIiwiaXAiLCJpbnN0YWxsYXRpb25JZCIsIm9iamVjdCIsIlVzZXIiLCJmcm9tSlNPTiIsImFzc2lnbiIsImNyZWF0ZWRXaXRoIiwiUmVzdFdyaXRlIiwiYnVpbGRDcmVhdGVkV2l0aCIsImlzTWFpbnRlbmFuY2UiLCJ2ZXJpZnlVc2VyRW1haWxzIiwicHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCIsImVtYWlsVmVyaWZpZWQiLCJFTUFJTF9OT1RfRk9VTkQiLCJjYXRjaCIsImVycm9yIiwiaGFuZGxlTWUiLCJpbmZvIiwic2Vzc2lvblRva2VuIiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCJzZXNzaW9uUmVzcG9uc2UiLCJyZXN0IiwiY29udGV4dCIsInVzZXJJZCIsIm9iamVjdElkIiwidXNlclJlc3BvbnNlIiwiZ2V0IiwicmVzcG9uc2UiLCJoYW5kbGVMb2dJbiIsImNoZWNrSWZVc2VySGFzUHJvdmlkZWRDb25maWd1cmVkUHJvdmlkZXJzRm9yTG9naW4iLCJhdXRoRGF0YVJlc3BvbnNlIiwidmFsaWRhdGVkQXV0aERhdGEiLCJyZXMiLCJoYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24iLCJwYXNzd29yZFBvbGljeSIsIm1heFBhc3N3b3JkQWdlIiwiY2hhbmdlZEF0IiwiX3Bhc3N3b3JkX2NoYW5nZWRfYXQiLCJEYXRlIiwidXBkYXRlIiwiX2VuY29kZSIsIl9fdHlwZSIsImlzbyIsImV4cGlyZXNBdCIsImdldFRpbWUiLCJmaWxlc0NvbnRyb2xsZXIiLCJleHBhbmRGaWxlc0luT2JqZWN0IiwibWF5YmVSdW5UcmlnZ2VyIiwiVHJpZ2dlclR5cGVzIiwiYmVmb3JlTG9naW4iLCJhcHBseUF1dGhEYXRhT3B0aW1pc3RpY0xvY2siLCJjb2RlIiwiU0NSSVBUX0ZBSUxFRCIsInNlc3Npb25EYXRhIiwiY3JlYXRlU2Vzc2lvbiIsImFmdGVyTG9naW5Vc2VyIiwiYWZ0ZXJMb2dpbiIsInJlZmV0Y2hBdXRoIiwiZmlsdGVyZWRVc2VyIiwiZmlsdGVyZWRVc2VyUmVzcG9uc2UiLCJoYW5kbGVMb2dJbkFzIiwiT1BFUkFUSU9OX0ZPUkJJRERFTiIsImlzUmVhZE9ubHkiLCJJTlZBTElEX1ZBTFVFIiwicXVlcnlSZXN1bHRzIiwiaGFuZGxlVmVyaWZ5UGFzc3dvcmQiLCJoYW5kbGVMb2dPdXQiLCJzdWNjZXNzIiwicmVjb3JkcyIsInVuZGVmaW5lZCIsImRlbCIsImFmdGVyTG9nb3V0IiwiU2Vzc2lvbiIsIl90aHJvd09uQmFkRW1haWxDb25maWciLCJDb25maWciLCJ2YWxpZGF0ZUVtYWlsQ29uZmlndXJhdGlvbiIsImVtYWlsQWRhcHRlciIsInVzZXJDb250cm9sbGVyIiwiYWRhcHRlciIsImFwcE5hbWUiLCJwdWJsaWNTZXJ2ZXJVUkwiLCJfcHVibGljU2VydmVyVVJMIiwiZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24iLCJlbWFpbFZlcmlmeVRva2VuUmV1c2VJZlZhbGlkIiwiSU5URVJOQUxfU0VSVkVSX0VSUk9SIiwiaGFuZGxlUmVzZXRSZXF1ZXN0IiwidG9rZW4iLCJFTUFJTF9NSVNTSU5HIiwidXNlclJlc3VsdHMiLCJ1c2VyRGF0YSIsIl9wZXJpc2hhYmxlX3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsIiRsdCIsIiRleGlzdHMiLCJsaW1pdCIsIklOVkFMSURfRU1BSUxfQUREUkVTUyIsImluZmxhdGUiLCJiZWZvcmVQYXNzd29yZFJlc2V0UmVxdWVzdCIsInNlbmRQYXNzd29yZFJlc2V0RW1haWwiLCJlcnIiLCJyZXNldFBhc3N3b3JkU3VjY2Vzc09uSW52YWxpZEVtYWlsIiwibWVzc2FnZSIsImhhbmRsZVZlcmlmaWNhdGlvbkVtYWlsUmVxdWVzdCIsInZlcmlmeUVtYWlsU3VjY2Vzc09uSW52YWxpZEVtYWlsIiwiZW1haWxWZXJpZnlTdWNjZXNzT25JbnZhbGlkRW1haWwiLCJPVEhFUl9DQVVTRSIsInNlbmQiLCJyZWdlbmVyYXRlRW1haWxWZXJpZnlUb2tlbiIsInNlbmRWZXJpZmljYXRpb25FbWFpbCIsImhhbmRsZUNoYWxsZW5nZSIsImNoYWxsZW5nZURhdGEiLCJwYXJzZVVzZXIiLCJBcnJheSIsImlzQXJyYXkiLCJpZCIsImZpbmRVc2Vyc1dpdGhBdXRoRGF0YSIsImdldFJlcXVlc3RPYmplY3QiLCJpc0NoYWxsZW5nZSIsInZhbGlkYXRvciIsImF1dGhEYXRhTWFuYWdlciIsImdldFZhbGlkYXRvckZvclByb3ZpZGVyIiwidmFsaWRhdG9yUmVzcG9uc2UiLCJsb2dnZXIiLCJhY2MiLCJzb3J0IiwiYXV0aEFkYXB0ZXIiLCJjaGFsbGVuZ2UiLCJwcm92aWRlckNoYWxsZW5nZVJlc3BvbnNlIiwicmVzb2x2ZUVycm9yIiwidXNlclN0cmluZyIsIkpTT04iLCJzdHJpbmdpZnkiLCJhdXRoZW50aWNhdGlvblN0ZXAiLCJtb3VudFJvdXRlcyIsInJvdXRlIiwiaGFuZGxlRmluZCIsInByb21pc2VFbnN1cmVJZGVtcG90ZW5jeSIsImhhbmRsZUNyZWF0ZSIsImhhbmRsZUdldCIsImhhbmRsZVVwZGF0ZSIsImhhbmRsZURlbGV0ZSIsImV4cG9ydHMiLCJfZGVmYXVsdCJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Sb3V0ZXJzL1VzZXJzUm91dGVyLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFRoZXNlIG1ldGhvZHMgaGFuZGxlIHRoZSBVc2VyLXJlbGF0ZWQgcm91dGVzLlxuXG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgQ29uZmlnIGZyb20gJy4uL0NvbmZpZyc7XG5pbXBvcnQgQWNjb3VudExvY2tvdXQgZnJvbSAnLi4vQWNjb3VudExvY2tvdXQnO1xuaW1wb3J0IENsYXNzZXNSb3V0ZXIgZnJvbSAnLi9DbGFzc2VzUm91dGVyJztcbmltcG9ydCByZXN0IGZyb20gJy4uL3Jlc3QnO1xuaW1wb3J0IEF1dGggZnJvbSAnLi4vQXV0aCc7XG5pbXBvcnQgcGFzc3dvcmRDcnlwdG8gZnJvbSAnLi4vcGFzc3dvcmQnO1xuaW1wb3J0IHtcbiAgbWF5YmVSdW5UcmlnZ2VyLFxuICBUeXBlcyBhcyBUcmlnZ2VyVHlwZXMsXG4gIGdldFJlcXVlc3RPYmplY3QsXG4gIHJlc29sdmVFcnJvcixcbiAgaW5mbGF0ZSxcbn0gZnJvbSAnLi4vdHJpZ2dlcnMnO1xuaW1wb3J0IHsgcHJvbWlzZUVuc3VyZUlkZW1wb3RlbmN5IH0gZnJvbSAnLi4vbWlkZGxld2FyZXMnO1xuaW1wb3J0IFJlc3RXcml0ZSBmcm9tICcuLi9SZXN0V3JpdGUnO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSAnLi4vbG9nZ2VyJztcbmltcG9ydCB7IGNyZWF0ZVNhbml0aXplZEVycm9yIH0gZnJvbSAnLi4vRXJyb3InO1xuaW1wb3J0IHsgYXBwbHlBdXRoRGF0YU9wdGltaXN0aWNMb2NrIH0gZnJvbSAnLi4vQXV0aERhdGFMb2NrJztcblxuZXhwb3J0IGNsYXNzIFVzZXJzUm91dGVyIGV4dGVuZHMgQ2xhc3Nlc1JvdXRlciB7XG4gIGNsYXNzTmFtZSgpIHtcbiAgICByZXR1cm4gJ19Vc2VyJztcbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmVzIGFsbCBcIl9cIiBwcmVmaXhlZCBwcm9wZXJ0aWVzIGZyb20gYW4gb2JqZWN0LCBleGNlcHQgXCJfX3R5cGVcIlxuICAgKiBAcGFyYW0ge09iamVjdH0gb2JqIEFuIG9iamVjdC5cbiAgICovXG4gIHN0YXRpYyByZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzKG9iaikge1xuICAgIGZvciAodmFyIGtleSBpbiBvYmopIHtcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBrZXkpKSB7XG4gICAgICAgIC8vIFJlZ2V4cCBjb21lcyBmcm9tIFBhcnNlLk9iamVjdC5wcm90b3R5cGUudmFsaWRhdGVcbiAgICAgICAgaWYgKGtleSAhPT0gJ19fdHlwZScgJiYgIS9eW0EtWmEtel1bMC05QS1aYS16X10qJC8udGVzdChrZXkpKSB7XG4gICAgICAgICAgZGVsZXRlIG9ialtrZXldO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEFmdGVyIHJldHJpZXZpbmcgYSB1c2VyIGRpcmVjdGx5IGZyb20gdGhlIGRhdGFiYXNlLCB3ZSBuZWVkIHRvIHJlbW92ZSB0aGVcbiAgICogcGFzc3dvcmQgZnJvbSB0aGUgb2JqZWN0IChmb3Igc2VjdXJpdHkpLCBhbmQgZml4IGFuIGlzc3VlIHNvbWUgU0RLcyBoYXZlXG4gICAqIHdpdGggbnVsbCB2YWx1ZXNcbiAgICovXG4gIF9zYW5pdGl6ZUF1dGhEYXRhKHVzZXIpIHtcbiAgICBkZWxldGUgdXNlci5wYXNzd29yZDtcblxuICAgIC8vIFNvbWV0aW1lcyB0aGUgYXV0aERhdGEgc3RpbGwgaGFzIG51bGwgb24gdGhhdCBrZXlzXG4gICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL3BhcnNlLWNvbW11bml0eS9wYXJzZS1zZXJ2ZXIvaXNzdWVzLzkzNVxuICAgIGlmICh1c2VyLmF1dGhEYXRhKSB7XG4gICAgICBPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgICAgaWYgKHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdID09PSBudWxsKSB7XG4gICAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGlmIChPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5sZW5ndGggPT0gMCkge1xuICAgICAgICBkZWxldGUgdXNlci5hdXRoRGF0YTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogVmFsaWRhdGVzIGEgcGFzc3dvcmQgcmVxdWVzdCBpbiBsb2dpbiBhbmQgdmVyaWZ5UGFzc3dvcmRcbiAgICogQHBhcmFtIHtPYmplY3R9IHJlcSBUaGUgcmVxdWVzdFxuICAgKiBAcmV0dXJucyB7T2JqZWN0fSBVc2VyIG9iamVjdFxuICAgKiBAcHJpdmF0ZVxuICAgKi9cbiAgX2F1dGhlbnRpY2F0ZVVzZXJGcm9tUmVxdWVzdChyZXEpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgLy8gVXNlIHF1ZXJ5IHBhcmFtZXRlcnMgaW5zdGVhZCBpZiBwcm92aWRlZCBpbiB1cmxcbiAgICAgIGxldCBwYXlsb2FkID0gcmVxLmJvZHkgfHwge307XG4gICAgICBpZiAoXG4gICAgICAgICghcGF5bG9hZC51c2VybmFtZSAmJiByZXEucXVlcnkgJiYgcmVxLnF1ZXJ5LnVzZXJuYW1lKSB8fFxuICAgICAgICAoIXBheWxvYWQuZW1haWwgJiYgcmVxLnF1ZXJ5ICYmIHJlcS5xdWVyeS5lbWFpbClcbiAgICAgICkge1xuICAgICAgICBwYXlsb2FkID0gcmVxLnF1ZXJ5O1xuICAgICAgfVxuICAgICAgY29uc3QgeyB1c2VybmFtZSwgZW1haWwsIHBhc3N3b3JkLCBpZ25vcmVFbWFpbFZlcmlmaWNhdGlvbiB9ID0gcGF5bG9hZDtcblxuICAgICAgLy8gVE9ETzogdXNlIHRoZSByaWdodCBlcnJvciBjb2RlcyAvIGRlc2NyaXB0aW9ucy5cbiAgICAgIGlmICghdXNlcm5hbWUgJiYgIWVtYWlsKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5VU0VSTkFNRV9NSVNTSU5HLCAndXNlcm5hbWUvZW1haWwgaXMgcmVxdWlyZWQuJyk7XG4gICAgICB9XG4gICAgICBpZiAoIXBhc3N3b3JkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5QQVNTV09SRF9NSVNTSU5HLCAncGFzc3dvcmQgaXMgcmVxdWlyZWQuJyk7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgIHR5cGVvZiBwYXNzd29yZCAhPT0gJ3N0cmluZycgfHxcbiAgICAgICAgKGVtYWlsICYmIHR5cGVvZiBlbWFpbCAhPT0gJ3N0cmluZycpIHx8XG4gICAgICAgICh1c2VybmFtZSAmJiB0eXBlb2YgdXNlcm5hbWUgIT09ICdzdHJpbmcnKVxuICAgICAgKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnSW52YWxpZCB1c2VybmFtZS9wYXNzd29yZC4nKTtcbiAgICAgIH1cblxuICAgICAgbGV0IHVzZXI7XG4gICAgICBsZXQgaXNWYWxpZFBhc3N3b3JkID0gZmFsc2U7XG4gICAgICBsZXQgcXVlcnk7XG4gICAgICBpZiAoZW1haWwgJiYgdXNlcm5hbWUpIHtcbiAgICAgICAgcXVlcnkgPSB7IGVtYWlsLCB1c2VybmFtZSB9O1xuICAgICAgfSBlbHNlIGlmIChlbWFpbCkge1xuICAgICAgICBxdWVyeSA9IHsgZW1haWwgfTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHF1ZXJ5ID0geyAkb3I6IFt7IHVzZXJuYW1lIH0sIHsgZW1haWw6IHVzZXJuYW1lIH1dIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVxLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAuZmluZCgnX1VzZXInLCBxdWVyeSwge30sIEF1dGgubWFpbnRlbmFuY2UocmVxLmNvbmZpZykpXG4gICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgIGlmICghcmVzdWx0cy5sZW5ndGgpIHtcbiAgICAgICAgICAgIC8vIFBlcmZvcm0gYSBkdW1teSBiY3J5cHQgY29tcGFyZSB0byBub3JtYWxpemUgcmVzcG9uc2UgdGltaW5nLFxuICAgICAgICAgICAgLy8gcHJldmVudGluZyB1c2VyIGVudW1lcmF0aW9uIHZpYSB0aW1pbmcgc2lkZS1jaGFubmVsXG4gICAgICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG9cbiAgICAgICAgICAgICAgLmNvbXBhcmUocGFzc3dvcmQsIHBhc3N3b3JkQ3J5cHRvLmR1bW15SGFzaClcbiAgICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnSW52YWxpZCB1c2VybmFtZS9wYXNzd29yZC4nKTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgLy8gY29ybmVyIGNhc2Ugd2hlcmUgdXNlcjEgaGFzIHVzZXJuYW1lID09IHVzZXIyIGVtYWlsXG4gICAgICAgICAgICByZXEuY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIud2FybihcbiAgICAgICAgICAgICAgXCJUaGVyZSBpcyBhIHVzZXIgd2hpY2ggZW1haWwgaXMgdGhlIHNhbWUgYXMgYW5vdGhlciB1c2VyJ3MgdXNlcm5hbWUsIGxvZ2dpbmcgaW4gYmFzZWQgb24gdXNlcm5hbWVcIlxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHVzZXIgPSByZXN1bHRzLmZpbHRlcih1c2VyID0+IHVzZXIudXNlcm5hbWUgPT09IHVzZXJuYW1lKVswXTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHR5cGVvZiB1c2VyLnBhc3N3b3JkICE9PSAnc3RyaW5nJyB8fCB1c2VyLnBhc3N3b3JkLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgLy8gUGFzc3dvcmRsZXNzIGFjY291bnQgKGUuZy4gT0F1dGgtb25seSk6IHJ1biBkdW1teSBjb21wYXJlIGZvclxuICAgICAgICAgICAgLy8gdGltaW5nIG5vcm1hbGl6YXRpb24sIGRpc2NhcmQgcmVzdWx0LCBhbHdheXMgcmVqZWN0XG4gICAgICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uY29tcGFyZShwYXNzd29yZCwgcGFzc3dvcmRDcnlwdG8uZHVtbXlIYXNoKS50aGVuKCgpID0+IGZhbHNlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHBhc3N3b3JkQ3J5cHRvLmNvbXBhcmUocGFzc3dvcmQsIHVzZXIucGFzc3dvcmQpO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbihjb3JyZWN0ID0+IHtcbiAgICAgICAgICBpc1ZhbGlkUGFzc3dvcmQgPSBjb3JyZWN0O1xuICAgICAgICAgIGNvbnN0IGFjY291bnRMb2Nrb3V0UG9saWN5ID0gbmV3IEFjY291bnRMb2Nrb3V0KHVzZXIsIHJlcS5jb25maWcpO1xuICAgICAgICAgIHJldHVybiBhY2NvdW50TG9ja291dFBvbGljeS5oYW5kbGVMb2dpbkF0dGVtcHQoaXNWYWxpZFBhc3N3b3JkKTtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGlmICghaXNWYWxpZFBhc3N3b3JkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ0ludmFsaWQgdXNlcm5hbWUvcGFzc3dvcmQuJyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEEgdXNlciB3aXRoIGFuIGVtcHR5IEFDTCAobWFzdGVyIGtleSBvbmx5KSBpcyBjb25zaWRlcmVkIGxvY2tlZCBvdXQgYW5kXG4gICAgICAgICAgLy8gY2Fubm90IGxvZyBpbi4gVGhpcyBvbmx5IHByZXZlbnRzIG5ldyBsb2dpbnM7IGV4aXN0aW5nIHNlc3Npb24gdG9rZW5zXG4gICAgICAgICAgLy8gcmVtYWluIHZhbGlkLiBUbyBpbW1lZGlhdGVseSByZXZva2UgYWNjZXNzLCBhbHNvIGRlc3Ryb3kgdGhlIHVzZXInc1xuICAgICAgICAgIC8vIHNlc3Npb25zIHZpYSBtYXN0ZXIga2V5LlxuICAgICAgICAgIGlmICghcmVxLmF1dGguaXNNYXN0ZXIgJiYgdXNlci5BQ0wgJiYgT2JqZWN0LmtleXModXNlci5BQ0wpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ0ludmFsaWQgdXNlcm5hbWUvcGFzc3dvcmQuJyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIENyZWF0ZSByZXF1ZXN0IG9iamVjdCBmb3IgdmVyaWZpY2F0aW9uIGZ1bmN0aW9uc1xuICAgICAgICAgIGNvbnN0IGF1dGhQcm92aWRlciA9XG4gICAgICAgICAgICByZXEuYm9keSAmJlxuICAgICAgICAgICAgcmVxLmJvZHkuYXV0aERhdGEgJiZcbiAgICAgICAgICAgIE9iamVjdC5rZXlzKHJlcS5ib2R5LmF1dGhEYXRhKS5sZW5ndGggJiZcbiAgICAgICAgICAgIE9iamVjdC5rZXlzKHJlcS5ib2R5LmF1dGhEYXRhKS5qb2luKCcsJyk7XG4gICAgICAgICAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAgICAgICAgIG1hc3RlcjogcmVxLmF1dGguaXNNYXN0ZXIsXG4gICAgICAgICAgICBpcDogcmVxLmNvbmZpZy5pcCxcbiAgICAgICAgICAgIGluc3RhbGxhdGlvbklkOiByZXEuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgIG9iamVjdDogUGFyc2UuVXNlci5mcm9tSlNPTihPYmplY3QuYXNzaWduKHsgY2xhc3NOYW1lOiAnX1VzZXInIH0sIHVzZXIpKSxcbiAgICAgICAgICAgIGNyZWF0ZWRXaXRoOiBSZXN0V3JpdGUuYnVpbGRDcmVhdGVkV2l0aCgnbG9naW4nLCBhdXRoUHJvdmlkZXIpLFxuICAgICAgICAgIH07XG5cbiAgICAgICAgICAvLyBJZiByZXF1ZXN0IGRvZXNuJ3QgdXNlIG1hc3RlciBvciBtYWludGVuYW5jZSBrZXkgd2l0aCBpZ25vcmluZyBlbWFpbCB2ZXJpZmljYXRpb25cbiAgICAgICAgICBpZiAoISgocmVxLmF1dGguaXNNYXN0ZXIgfHwgcmVxLmF1dGguaXNNYWludGVuYW5jZSkgJiYgaWdub3JlRW1haWxWZXJpZmljYXRpb24pKSB7XG5cbiAgICAgICAgICAgIC8vIEdldCB2ZXJpZmljYXRpb24gY29uZGl0aW9ucyB3aGljaCBjYW4gYmUgYm9vbGVhbnMgb3IgZnVuY3Rpb25zOyB0aGUgcHVycG9zZSBvZiB0aGlzIGFzeW5jL2F3YWl0XG4gICAgICAgICAgICAvLyBzdHJ1Y3R1cmUgaXMgdG8gYXZvaWQgdW5uZWNlc3NhcmlseSBleGVjdXRpbmcgc3Vic2VxdWVudCBmdW5jdGlvbnMgaWYgcHJldmlvdXMgb25lcyBmYWlsIGluIHRoZVxuICAgICAgICAgICAgLy8gY29uZGl0aW9uYWwgc3RhdGVtZW50IGJlbG93LCBhcyBhIGRldmVsb3BlciBtYXkgZGVjaWRlIHRvIGV4ZWN1dGUgZXhwZW5zaXZlIG9wZXJhdGlvbnMgaW4gdGhlbVxuICAgICAgICAgICAgY29uc3QgdmVyaWZ5VXNlckVtYWlscyA9IGFzeW5jICgpID0+IHJlcS5jb25maWcudmVyaWZ5VXNlckVtYWlscyA9PT0gdHJ1ZSB8fCAodHlwZW9mIHJlcS5jb25maWcudmVyaWZ5VXNlckVtYWlscyA9PT0gJ2Z1bmN0aW9uJyAmJiBhd2FpdCBQcm9taXNlLnJlc29sdmUocmVxLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzKHJlcXVlc3QpKSA9PT0gdHJ1ZSk7XG4gICAgICAgICAgICBjb25zdCBwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID0gYXN5bmMgKCkgPT4gcmVxLmNvbmZpZy5wcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID09PSB0cnVlIHx8ICh0eXBlb2YgcmVxLmNvbmZpZy5wcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID09PSAnZnVuY3Rpb24nICYmIGF3YWl0IFByb21pc2UucmVzb2x2ZShyZXEuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwocmVxdWVzdCkpID09PSB0cnVlKTtcbiAgICAgICAgICAgIGlmIChhd2FpdCB2ZXJpZnlVc2VyRW1haWxzKCkgJiYgYXdhaXQgcHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCgpICYmICF1c2VyLmVtYWlsVmVyaWZpZWQpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX05PVF9GT1VORCwgJ1VzZXIgZW1haWwgaXMgbm90IHZlcmlmaWVkLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIHRoaXMuX3Nhbml0aXplQXV0aERhdGEodXNlcik7XG5cbiAgICAgICAgICByZXR1cm4gcmVzb2x2ZSh1c2VyKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICByZXR1cm4gcmVqZWN0KGVycm9yKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBoYW5kbGVNZShyZXEpIHtcbiAgICBpZiAoIXJlcS5pbmZvIHx8ICFyZXEuaW5mby5zZXNzaW9uVG9rZW4pIHtcbiAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTiwgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbicsIHJlcS5jb25maWcpO1xuICAgIH1cbiAgICBjb25zdCBzZXNzaW9uVG9rZW4gPSByZXEuaW5mby5zZXNzaW9uVG9rZW47XG4gICAgLy8gUXVlcnkgdGhlIHNlc3Npb24gd2l0aCBtYXN0ZXIga2V5IHRvIHZhbGlkYXRlIHRoZSBzZXNzaW9uIHRva2VuLFxuICAgIC8vIGJ1dCBkbyBOT1QgaW5jbHVkZSAndXNlcicgdG8gYXZvaWQgbGVha2luZyB1c2VyIGRhdGEgdmlhIG1hc3RlciBjb250ZXh0XG4gICAgY29uc3Qgc2Vzc2lvblJlc3BvbnNlID0gYXdhaXQgcmVzdC5maW5kKFxuICAgICAgcmVxLmNvbmZpZyxcbiAgICAgIEF1dGgubWFzdGVyKHJlcS5jb25maWcpLFxuICAgICAgJ19TZXNzaW9uJyxcbiAgICAgIHsgc2Vzc2lvblRva2VuIH0sXG4gICAgICB7fSxcbiAgICAgIHJlcS5pbmZvLmNvbnRleHRcbiAgICApO1xuICAgIGlmIChcbiAgICAgICFzZXNzaW9uUmVzcG9uc2UucmVzdWx0cyB8fFxuICAgICAgc2Vzc2lvblJlc3BvbnNlLnJlc3VsdHMubGVuZ3RoID09IDAgfHxcbiAgICAgICFzZXNzaW9uUmVzcG9uc2UucmVzdWx0c1swXS51c2VyXG4gICAgKSB7XG4gICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sICdJbnZhbGlkIHNlc3Npb24gdG9rZW4nLCByZXEuY29uZmlnKTtcbiAgICB9XG4gICAgY29uc3QgdXNlcklkID0gc2Vzc2lvblJlc3BvbnNlLnJlc3VsdHNbMF0udXNlci5vYmplY3RJZDtcbiAgICAvLyBSZS1mZXRjaCB0aGUgdXNlciB3aXRoIHRoZSBjYWxsZXIncyBhdXRoIGNvbnRleHQgc28gdGhhdFxuICAgIC8vIHByb3RlY3RlZEZpZWxkcywgQ0xQLCBhbmQgYXV0aCBhZGFwdGVyIGFmdGVyRmluZCBhcHBseSBjb3JyZWN0bHlcbiAgICBjb25zdCB1c2VyUmVzcG9uc2UgPSBhd2FpdCByZXN0LmdldChcbiAgICAgIHJlcS5jb25maWcsXG4gICAgICByZXEuYXV0aCxcbiAgICAgICdfVXNlcicsXG4gICAgICB1c2VySWQsXG4gICAgICB7fSxcbiAgICAgIHJlcS5pbmZvLmNvbnRleHRcbiAgICApO1xuICAgIGlmICghdXNlclJlc3BvbnNlLnJlc3VsdHMgfHwgdXNlclJlc3BvbnNlLnJlc3VsdHMubGVuZ3RoID09IDApIHtcbiAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTiwgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbicsIHJlcS5jb25maWcpO1xuICAgIH1cbiAgICBjb25zdCB1c2VyID0gdXNlclJlc3BvbnNlLnJlc3VsdHNbMF07XG4gICAgLy8gU2VuZCB0b2tlbiBiYWNrIG9uIHRoZSBsb2dpbiwgYmVjYXVzZSBTREtzIGV4cGVjdCB0aGF0LlxuICAgIHVzZXIuc2Vzc2lvblRva2VuID0gc2Vzc2lvblRva2VuO1xuICAgIC8vIFJlbW92ZSBoaWRkZW4gcHJvcGVydGllcy5cbiAgICBVc2Vyc1JvdXRlci5yZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzKHVzZXIpO1xuICAgIHJldHVybiB7IHJlc3BvbnNlOiB1c2VyIH07XG4gIH1cblxuICBhc3luYyBoYW5kbGVMb2dJbihyZXEpIHtcbiAgICBjb25zdCB1c2VyID0gYXdhaXQgdGhpcy5fYXV0aGVudGljYXRlVXNlckZyb21SZXF1ZXN0KHJlcSk7XG4gICAgY29uc3QgYXV0aERhdGEgPSByZXEuYm9keSAmJiByZXEuYm9keS5hdXRoRGF0YTtcbiAgICAvLyBDaGVjayBpZiB1c2VyIGhhcyBwcm92aWRlZCB0aGVpciByZXF1aXJlZCBhdXRoIHByb3ZpZGVyc1xuICAgIEF1dGguY2hlY2tJZlVzZXJIYXNQcm92aWRlZENvbmZpZ3VyZWRQcm92aWRlcnNGb3JMb2dpbihcbiAgICAgIHJlcSxcbiAgICAgIGF1dGhEYXRhLFxuICAgICAgdXNlci5hdXRoRGF0YSxcbiAgICAgIHJlcS5jb25maWdcbiAgICApO1xuXG4gICAgbGV0IGF1dGhEYXRhUmVzcG9uc2U7XG4gICAgbGV0IHZhbGlkYXRlZEF1dGhEYXRhO1xuICAgIGlmIChhdXRoRGF0YSkge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgQXV0aC5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24oXG4gICAgICAgIGF1dGhEYXRhLFxuICAgICAgICBuZXcgUmVzdFdyaXRlKFxuICAgICAgICAgIHJlcS5jb25maWcsXG4gICAgICAgICAgcmVxLmF1dGgsXG4gICAgICAgICAgJ19Vc2VyJyxcbiAgICAgICAgICB7IG9iamVjdElkOiB1c2VyLm9iamVjdElkIH0sXG4gICAgICAgICAgcmVxLmJvZHkgfHwge30sXG4gICAgICAgICAgdXNlcixcbiAgICAgICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgICAgICksXG4gICAgICAgIHVzZXJcbiAgICAgICk7XG4gICAgICBhdXRoRGF0YVJlc3BvbnNlID0gcmVzLmF1dGhEYXRhUmVzcG9uc2U7XG4gICAgICB2YWxpZGF0ZWRBdXRoRGF0YSA9IHJlcy5hdXRoRGF0YTtcbiAgICB9XG5cbiAgICAvLyBoYW5kbGUgcGFzc3dvcmQgZXhwaXJ5IHBvbGljeVxuICAgIGlmIChyZXEuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmIHJlcS5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UpIHtcbiAgICAgIGxldCBjaGFuZ2VkQXQgPSB1c2VyLl9wYXNzd29yZF9jaGFuZ2VkX2F0O1xuXG4gICAgICBpZiAoIWNoYW5nZWRBdCkge1xuICAgICAgICAvLyBwYXNzd29yZCB3YXMgY3JlYXRlZCBiZWZvcmUgZXhwaXJ5IHBvbGljeSB3YXMgZW5hYmxlZC5cbiAgICAgICAgLy8gc2ltcGx5IHVwZGF0ZSBfVXNlciBvYmplY3Qgc28gdGhhdCBpdCB3aWxsIHN0YXJ0IGVuZm9yY2luZyBmcm9tIG5vd1xuICAgICAgICBjaGFuZ2VkQXQgPSBuZXcgRGF0ZSgpO1xuICAgICAgICByZXEuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZShcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHsgdXNlcm5hbWU6IHVzZXIudXNlcm5hbWUgfSxcbiAgICAgICAgICB7IF9wYXNzd29yZF9jaGFuZ2VkX2F0OiBQYXJzZS5fZW5jb2RlKGNoYW5nZWRBdCkgfVxuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gY2hlY2sgd2hldGhlciB0aGUgcGFzc3dvcmQgaGFzIGV4cGlyZWRcbiAgICAgICAgaWYgKGNoYW5nZWRBdC5fX3R5cGUgPT0gJ0RhdGUnKSB7XG4gICAgICAgICAgY2hhbmdlZEF0ID0gbmV3IERhdGUoY2hhbmdlZEF0Lmlzbyk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gQ2FsY3VsYXRlIHRoZSBleHBpcnkgdGltZS5cbiAgICAgICAgY29uc3QgZXhwaXJlc0F0ID0gbmV3IERhdGUoXG4gICAgICAgICAgY2hhbmdlZEF0LmdldFRpbWUoKSArIDg2NDAwMDAwICogcmVxLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZVxuICAgICAgICApO1xuICAgICAgICBpZiAoZXhwaXJlc0F0IDwgbmV3IERhdGUoKSlcbiAgICAgICAgLy8gZmFpbCBvZiBjdXJyZW50IHRpbWUgaXMgcGFzdCBwYXNzd29yZCBleHBpcnkgdGltZVxuICAgICAgICB7IHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgICdZb3VyIHBhc3N3b3JkIGhhcyBleHBpcmVkLiBQbGVhc2UgcmVzZXQgeW91ciBwYXNzd29yZC4nXG4gICAgICAgICk7IH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSZW1vdmUgaGlkZGVuIHByb3BlcnRpZXMuXG4gICAgVXNlcnNSb3V0ZXIucmVtb3ZlSGlkZGVuUHJvcGVydGllcyh1c2VyKTtcblxuICAgIGF3YWl0IHJlcS5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QocmVxLmNvbmZpZywgdXNlcik7XG5cbiAgICAvLyBCZWZvcmUgbG9naW4gdHJpZ2dlcjsgdGhyb3dzIGlmIGZhaWx1cmVcbiAgICBhd2FpdCBtYXliZVJ1blRyaWdnZXIoXG4gICAgICBUcmlnZ2VyVHlwZXMuYmVmb3JlTG9naW4sXG4gICAgICByZXEuYXV0aCxcbiAgICAgIFBhcnNlLlVzZXIuZnJvbUpTT04oT2JqZWN0LmFzc2lnbih7IGNsYXNzTmFtZTogJ19Vc2VyJyB9LCB1c2VyKSksXG4gICAgICBudWxsLFxuICAgICAgcmVxLmNvbmZpZyxcbiAgICAgIHJlcS5pbmZvLmNvbnRleHRcbiAgICApO1xuXG4gICAgLy8gSWYgd2UgaGF2ZSBzb21lIG5ldyB2YWxpZGF0ZWQgYXV0aERhdGEgdXBkYXRlIGRpcmVjdGx5XG4gICAgaWYgKHZhbGlkYXRlZEF1dGhEYXRhICYmIE9iamVjdC5rZXlzKHZhbGlkYXRlZEF1dGhEYXRhKS5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0geyBvYmplY3RJZDogdXNlci5vYmplY3RJZCB9O1xuICAgICAgLy8gUHJldmVudCBjb25jdXJyZW50IHJlcXVlc3RzIGZyb20gYm90aCBzdWNjZWVkaW5nIHdoZW4gY29uc3VtaW5nIHNpbmdsZS11c2VcbiAgICAgIC8vIHRva2VucyAoZS5nLiBNRkEgcmVjb3ZlcnkgY29kZXMgb3IgU01TIE9UUCB0b2tlbnMpIGJ5IGV4dGVuZGluZyB0aGUgdXBkYXRlXG4gICAgICAvLyBXSEVSRSBjbGF1c2Ugd2l0aCB0aGUgb3JpZ2luYWwgdmFsdWVzIG9mIGNoYW5nZWQgcHJpbWl0aXZlL2FycmF5IGZpZWxkcy5cbiAgICAgIGFwcGx5QXV0aERhdGFPcHRpbWlzdGljTG9jayhxdWVyeSwgdXNlci5hdXRoRGF0YSwgdmFsaWRhdGVkQXV0aERhdGEpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgcmVxLmNvbmZpZy5kYXRhYmFzZS51cGRhdGUoJ19Vc2VyJywgcXVlcnksIHsgYXV0aERhdGE6IHZhbGlkYXRlZEF1dGhEYXRhIH0sIHt9KTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsICdJbnZhbGlkIGF1dGggZGF0YScpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IFJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uKHJlcS5jb25maWcsIHtcbiAgICAgIHVzZXJJZDogdXNlci5vYmplY3RJZCxcbiAgICAgIGNyZWF0ZWRXaXRoOiBSZXN0V3JpdGUuYnVpbGRDcmVhdGVkV2l0aCgnbG9naW4nKSxcbiAgICAgIGluc3RhbGxhdGlvbklkOiByZXEuaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICB9KTtcblxuICAgIHVzZXIuc2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuXG4gICAgYXdhaXQgY3JlYXRlU2Vzc2lvbigpO1xuXG4gICAgY29uc3QgYWZ0ZXJMb2dpblVzZXIgPSBQYXJzZS5Vc2VyLmZyb21KU09OKE9iamVjdC5hc3NpZ24oeyBjbGFzc05hbWU6ICdfVXNlcicgfSwgdXNlcikpO1xuICAgIGF3YWl0IG1heWJlUnVuVHJpZ2dlcihcbiAgICAgIFRyaWdnZXJUeXBlcy5hZnRlckxvZ2luLFxuICAgICAgeyAuLi5yZXEuYXV0aCwgdXNlcjogYWZ0ZXJMb2dpblVzZXIgfSxcbiAgICAgIGFmdGVyTG9naW5Vc2VyLFxuICAgICAgbnVsbCxcbiAgICAgIHJlcS5jb25maWcsXG4gICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgKTtcblxuICAgIC8vIFJlLWZldGNoIHRoZSB1c2VyIHdpdGggdGhlIGNhbGxlcidzIGF1dGggY29udGV4dCBzbyB0aGF0XG4gICAgLy8gcHJvdGVjdGVkRmllbGRzIGFuZCBDTFAgYXBwbHkgY29ycmVjdGx5OyBpZiB0aGUgY2FsbGVyIHVzZWQgbWFzdGVyIGtleSxcbiAgICAvLyBwcm90ZWN0ZWRGaWVsZHMgYXJlIGJ5cGFzc2VkLCBtYXRjaGluZyB0aGUgYmVoYXZpb3Igb2YgR0VUIC91c2Vycy86aWRcbiAgICBjb25zdCByZWZldGNoQXV0aCA9XG4gICAgICByZXEuYXV0aC5pc01hc3RlciB8fCByZXEuYXV0aC5pc01haW50ZW5hbmNlXG4gICAgICAgID8gcmVxLmF1dGhcbiAgICAgICAgOiBuZXcgQXV0aC5BdXRoKHtcbiAgICAgICAgICBjb25maWc6IHJlcS5jb25maWcsXG4gICAgICAgICAgaXNNYXN0ZXI6IGZhbHNlLFxuICAgICAgICAgIHVzZXI6IFBhcnNlLk9iamVjdC5mcm9tSlNPTih7IGNsYXNzTmFtZTogJ19Vc2VyJywgb2JqZWN0SWQ6IHVzZXIub2JqZWN0SWQgfSksXG4gICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHJlcS5pbmZvLmluc3RhbGxhdGlvbklkLFxuICAgICAgICB9KTtcbiAgICBsZXQgZmlsdGVyZWRVc2VyO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBmaWx0ZXJlZFVzZXJSZXNwb25zZSA9IGF3YWl0IHJlc3QuZ2V0KFxuICAgICAgICByZXEuY29uZmlnLFxuICAgICAgICByZWZldGNoQXV0aCxcbiAgICAgICAgJ19Vc2VyJyxcbiAgICAgICAgdXNlci5vYmplY3RJZCxcbiAgICAgICAge30sXG4gICAgICAgIHJlcS5pbmZvLmNvbnRleHRcbiAgICAgICk7XG4gICAgICBmaWx0ZXJlZFVzZXIgPSBmaWx0ZXJlZFVzZXJSZXNwb25zZS5yZXN1bHRzPy5bMF07XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBUaGUgcmUtZmV0Y2ggZW5mb3JjZXMgYF9Vc2VyYCBgZ2V0YCBDTFAgYW5kIG1heSBiZSBkZW5pZWQgYnkgYWNjZXNzXG4gICAgICAvLyBjb250cm9sIChlLmcuIENMUCBgZ2V0OiB7fWAgb3IgYW4gQUNMIHRoYXQgZXhjbHVkZXMgdGhlIGNhbGxlcikuXG4gICAgICAvLyBIYW5kbGVkIGJlbG93OyBuZXZlciBmYWxsIGJhY2sgdG8gdGhlIHJhdyByb3cuXG4gICAgfVxuICAgIGlmICghZmlsdGVyZWRVc2VyKSB7XG4gICAgICAvLyBNYXN0ZXIvbWFpbnRlbmFuY2UgY2FsbGVycyBieXBhc3MgQ0xQLCBwcm90ZWN0ZWRGaWVsZHMsIGFuZCBhdXRoRGF0YVxuICAgICAgLy8gYWZ0ZXJGaW5kLCBzbyBmb3IgdGhlbSBhbiBlbXB0eSByZS1mZXRjaCBpcyBhIGdlbnVpbmUgbm90LWZvdW5kIGVkZ2UsIG5vdFxuICAgICAgLy8gYW4gYWNjZXNzLWNvbnRyb2wgZGVuaWFsOyB0aGV5IGFyZSBlbnRpdGxlZCB0byB0aGUgZnVsbCByb3cuIEZvciBldmVyeVxuICAgICAgLy8gb3RoZXIgY2FsbGVyLCBhbiBlbXB0eS9kZW5pZWQgcmUtZmV0Y2ggbWVhbnMgYWNjZXNzIGNvbnRyb2wgd2l0aGhlbGQgdGhlXG4gICAgICAvLyByZWNvcmQsIHNvIGRpc2Nsb3NlIG9ubHkgdGhlIGlkZW50aXR5IOKAlCBuZXZlciB0aGUgcmF3IHJvdywgd2hpY2ggd291bGRcbiAgICAgIC8vIGxlYWsgZmllbGRzIGhpZGRlbiBieSBgcHJvdGVjdGVkRmllbGRzYCBhbmQgcmF3IGBhdXRoRGF0YWAgKGUuZy4gTUZBXG4gICAgICAvLyBzZWNyZXRzIGFuZCByZWNvdmVyeSBjb2RlcykgdGhhdCB0aGUgc2FuaXRpemluZyByZS1mZXRjaCB3b3VsZCByZW1vdmUuXG4gICAgICAvLyBUaGUgc2Vzc2lvbiB0b2tlbiBpcyBzdGlsbCBhdHRhY2hlZCBiZWxvdyBzbyBsb2dpbiBzdWNjZWVkcy5cbiAgICAgIGZpbHRlcmVkVXNlciA9XG4gICAgICAgIHJlcS5hdXRoLmlzTWFzdGVyIHx8IHJlcS5hdXRoLmlzTWFpbnRlbmFuY2UgPyB1c2VyIDogeyBvYmplY3RJZDogdXNlci5vYmplY3RJZCB9O1xuICAgIH1cbiAgICBVc2Vyc1JvdXRlci5yZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzKGZpbHRlcmVkVXNlcik7XG4gICAgZmlsdGVyZWRVc2VyLnNlc3Npb25Ub2tlbiA9IHVzZXIuc2Vzc2lvblRva2VuO1xuICAgIGlmIChhdXRoRGF0YVJlc3BvbnNlKSB7XG4gICAgICBmaWx0ZXJlZFVzZXIuYXV0aERhdGFSZXNwb25zZSA9IGF1dGhEYXRhUmVzcG9uc2U7XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgcmVzcG9uc2U6IGZpbHRlcmVkVXNlciB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFRoaXMgYWxsb3dzIG1hc3Rlci1rZXkgY2xpZW50cyB0byBjcmVhdGUgdXNlciBzZXNzaW9ucyB3aXRob3V0IGFjY2VzcyB0b1xuICAgKiB1c2VyIGNyZWRlbnRpYWxzLiBUaGlzIGVuYWJsZXMgc3lzdGVtcyB0aGF0IGNhbiBhdXRoZW50aWNhdGUgYWNjZXNzIGFub3RoZXJcbiAgICogd2F5IChBUEkga2V5LCBhcHAgYWRtaW5pc3RyYXRvcnMpIHRvIGFjdCBvbiBhIHVzZXIncyBiZWhhbGYuXG4gICAqXG4gICAqIFdlIGNyZWF0ZSBhIG5ldyBzZXNzaW9uIHJhdGhlciB0aGFuIGxvb2tpbmcgZm9yIGFuIGV4aXN0aW5nIHNlc3Npb247IHdlXG4gICAqIHdhbnQgdGhpcyB0byB3b3JrIGluIHNpdHVhdGlvbnMgd2hlcmUgdGhlIHVzZXIgaXMgbG9nZ2VkIG91dCBvbiBhbGxcbiAgICogZGV2aWNlcywgc2luY2UgdGhpcyBjYW4gYmUgdXNlZCBieSBhdXRvbWF0ZWQgc3lzdGVtcyBhY3Rpbmcgb24gdGhlIHVzZXInc1xuICAgKiBiZWhhbGYuXG4gICAqXG4gICAqIEZvciB0aGUgbW9tZW50LCB3ZSdyZSBvbWl0dGluZyBldmVudCBob29rcyBhbmQgbG9ja291dCBjaGVja3MsIHNpbmNlXG4gICAqIGltbWVkaWF0ZSB1c2UgY2FzZXMgc3VnZ2VzdCAvbG9naW5BcyBjb3VsZCBiZSB1c2VkIGZvciBzZW1hbnRpY2FsbHlcbiAgICogZGlmZmVyZW50IHJlYXNvbnMgZnJvbSAvbG9naW5cbiAgICovXG4gIGFzeW5jIGhhbmRsZUxvZ0luQXMocmVxKSB7XG4gICAgaWYgKCFyZXEuYXV0aC5pc01hc3Rlcikge1xuICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICdtYXN0ZXIga2V5IGlzIHJlcXVpcmVkJyxcbiAgICAgICAgcmVxLmNvbmZpZ1xuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJlcS5hdXRoLmlzUmVhZE9ubHkpIHtcbiAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICBcInJlYWQtb25seSBtYXN0ZXJLZXkgaXNuJ3QgYWxsb3dlZCB0byBsb2dpbiBhcyBhbm90aGVyIHVzZXIuXCIsXG4gICAgICAgIHJlcS5jb25maWdcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgdXNlcklkID0gcmVxLmJvZHk/LnVzZXJJZCB8fCByZXEucXVlcnkudXNlcklkO1xuICAgIGlmICghdXNlcklkKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfVkFMVUUsXG4gICAgICAgICd1c2VySWQgbXVzdCBub3QgYmUgZW1wdHksIG51bGwsIG9yIHVuZGVmaW5lZCdcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcXVlcnlSZXN1bHRzID0gYXdhaXQgcmVxLmNvbmZpZy5kYXRhYmFzZS5maW5kKCdfVXNlcicsIHsgb2JqZWN0SWQ6IHVzZXJJZCB9KTtcbiAgICBjb25zdCB1c2VyID0gcXVlcnlSZXN1bHRzWzBdO1xuICAgIGlmICghdXNlcikge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICd1c2VyIG5vdCBmb3VuZCcpO1xuICAgIH1cblxuICAgIHRoaXMuX3Nhbml0aXplQXV0aERhdGEodXNlcik7XG5cbiAgICBjb25zdCB7IHNlc3Npb25EYXRhLCBjcmVhdGVTZXNzaW9uIH0gPSBSZXN0V3JpdGUuY3JlYXRlU2Vzc2lvbihyZXEuY29uZmlnLCB7XG4gICAgICB1c2VySWQsXG4gICAgICBjcmVhdGVkV2l0aDogUmVzdFdyaXRlLmJ1aWxkQ3JlYXRlZFdpdGgoJ2xvZ2luJywgJ21hc3RlcmtleScpLFxuICAgICAgaW5zdGFsbGF0aW9uSWQ6IHJlcS5pbmZvLmluc3RhbGxhdGlvbklkLFxuICAgIH0pO1xuXG4gICAgdXNlci5zZXNzaW9uVG9rZW4gPSBzZXNzaW9uRGF0YS5zZXNzaW9uVG9rZW47XG5cbiAgICBhd2FpdCBjcmVhdGVTZXNzaW9uKCk7XG5cbiAgICByZXR1cm4geyByZXNwb25zZTogdXNlciB9O1xuICB9XG5cbiAgaGFuZGxlVmVyaWZ5UGFzc3dvcmQocmVxKSB7XG4gICAgcmV0dXJuIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXJGcm9tUmVxdWVzdChyZXEpXG4gICAgICAudGhlbihhc3luYyB1c2VyID0+IHtcbiAgICAgICAgLy8gUmVtb3ZlIGhpZGRlbiBwcm9wZXJ0aWVzLlxuICAgICAgICBVc2Vyc1JvdXRlci5yZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzKHVzZXIpO1xuICAgICAgICAvLyBSZS1mZXRjaCB0aGUgdXNlciB3aXRoIHRoZSBjYWxsZXIncyBhdXRoIGNvbnRleHQgc28gdGhhdFxuICAgICAgICAvLyBwcm90ZWN0ZWRGaWVsZHMgYW5kIENMUCBhcHBseSBjb3JyZWN0bHk7IGlmIHRoZSBjYWxsZXIgdXNlZCBtYXN0ZXIga2V5LFxuICAgICAgICAvLyBwcm90ZWN0ZWRGaWVsZHMgYXJlIGJ5cGFzc2VkLCBtYXRjaGluZyB0aGUgYmVoYXZpb3Igb2YgR0VUIC91c2Vycy86aWRcbiAgICAgICAgY29uc3QgcmVmZXRjaEF1dGggPVxuICAgICAgICAgIHJlcS5hdXRoLmlzTWFzdGVyIHx8IHJlcS5hdXRoLmlzTWFpbnRlbmFuY2VcbiAgICAgICAgICAgID8gcmVxLmF1dGhcbiAgICAgICAgICAgIDogbmV3IEF1dGguQXV0aCh7XG4gICAgICAgICAgICAgIGNvbmZpZzogcmVxLmNvbmZpZyxcbiAgICAgICAgICAgICAgaXNNYXN0ZXI6IGZhbHNlLFxuICAgICAgICAgICAgICB1c2VyOiBQYXJzZS5PYmplY3QuZnJvbUpTT04oeyBjbGFzc05hbWU6ICdfVXNlcicsIG9iamVjdElkOiB1c2VyLm9iamVjdElkIH0pLFxuICAgICAgICAgICAgICBpbnN0YWxsYXRpb25JZDogcmVxLmluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgbGV0IGZpbHRlcmVkVXNlcjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBmaWx0ZXJlZFVzZXJSZXNwb25zZSA9IGF3YWl0IHJlc3QuZ2V0KFxuICAgICAgICAgICAgcmVxLmNvbmZpZyxcbiAgICAgICAgICAgIHJlZmV0Y2hBdXRoLFxuICAgICAgICAgICAgJ19Vc2VyJyxcbiAgICAgICAgICAgIHVzZXIub2JqZWN0SWQsXG4gICAgICAgICAgICB7fSxcbiAgICAgICAgICAgIHJlcS5pbmZvLmNvbnRleHRcbiAgICAgICAgICApO1xuICAgICAgICAgIGZpbHRlcmVkVXNlciA9IGZpbHRlcmVkVXNlclJlc3BvbnNlLnJlc3VsdHM/LlswXTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gVGhlIHJlLWZldGNoIGVuZm9yY2VzIGBfVXNlcmAgYGdldGAgQ0xQIGFuZCBtYXkgYmUgZGVuaWVkIGJ5IGFjY2Vzc1xuICAgICAgICAgIC8vIGNvbnRyb2wgKGUuZy4gQ0xQIGBnZXQ6IHt9YCBvciBhbiBBQ0wgdGhhdCBleGNsdWRlcyB0aGUgY2FsbGVyKS5cbiAgICAgICAgICAvLyBIYW5kbGVkIGJlbG93OyBuZXZlciBmYWxsIGJhY2sgdG8gdGhlIHJhdyByb3cuXG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFmaWx0ZXJlZFVzZXIpIHtcbiAgICAgICAgICAvLyBTZWUgaGFuZGxlTG9nSW46IG1hc3Rlci9tYWludGVuYW5jZSBjYWxsZXJzIGJ5cGFzcyBDTFAsXG4gICAgICAgICAgLy8gcHJvdGVjdGVkRmllbGRzLCBhbmQgYXV0aERhdGEgYWZ0ZXJGaW5kLCBzbyBhbiBlbXB0eSByZS1mZXRjaCBpcyBhXG4gICAgICAgICAgLy8gZ2VudWluZSBub3QtZm91bmQgZWRnZSBmb3IgdGhlbSBhbmQgdGhleSBhcmUgZW50aXRsZWQgdG8gdGhlIGZ1bGxcbiAgICAgICAgICAvLyByb3cuIEZvciBhbGwgb3RoZXIgY2FsbGVycywgYW4gZW1wdHkvZGVuaWVkIHJlLWZldGNoIG1lYW5zIGFjY2Vzc1xuICAgICAgICAgIC8vIGNvbnRyb2wgd2l0aGhlbGQgdGhlIHJlY29yZCwgc28gZGlzY2xvc2Ugb25seSB0aGUgaWRlbnRpdHkgcmF0aGVyXG4gICAgICAgICAgLy8gdGhhbiB0aGUgcmF3IHJvdywgd2hpY2ggd291bGQgbGVhayBwcm90ZWN0ZWRGaWVsZHMgYW5kIHJhdyBhdXRoRGF0YVxuICAgICAgICAgIC8vIChlLmcuIE1GQSBzZWNyZXRzIGFuZCByZWNvdmVyeSBjb2RlcykuXG4gICAgICAgICAgZmlsdGVyZWRVc2VyID1cbiAgICAgICAgICAgIHJlcS5hdXRoLmlzTWFzdGVyIHx8IHJlcS5hdXRoLmlzTWFpbnRlbmFuY2UgPyB1c2VyIDogeyBvYmplY3RJZDogdXNlci5vYmplY3RJZCB9O1xuICAgICAgICB9XG4gICAgICAgIFVzZXJzUm91dGVyLnJlbW92ZUhpZGRlblByb3BlcnRpZXMoZmlsdGVyZWRVc2VyKTtcbiAgICAgICAgcmV0dXJuIHsgcmVzcG9uc2U6IGZpbHRlcmVkVXNlciB9O1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gIH1cblxuICBhc3luYyBoYW5kbGVMb2dPdXQocmVxKSB7XG4gICAgY29uc3Qgc3VjY2VzcyA9IHsgcmVzcG9uc2U6IHt9IH07XG4gICAgaWYgKHJlcS5pbmZvICYmIHJlcS5pbmZvLnNlc3Npb25Ub2tlbikge1xuICAgICAgY29uc3QgcmVjb3JkcyA9IGF3YWl0IHJlc3QuZmluZChcbiAgICAgICAgcmVxLmNvbmZpZyxcbiAgICAgICAgQXV0aC5tYXN0ZXIocmVxLmNvbmZpZyksXG4gICAgICAgICdfU2Vzc2lvbicsXG4gICAgICAgIHsgc2Vzc2lvblRva2VuOiByZXEuaW5mby5zZXNzaW9uVG9rZW4gfSxcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgICApO1xuICAgICAgaWYgKHJlY29yZHMucmVzdWx0cyAmJiByZWNvcmRzLnJlc3VsdHMubGVuZ3RoKSB7XG4gICAgICAgIGF3YWl0IHJlc3QuZGVsKFxuICAgICAgICAgIHJlcS5jb25maWcsXG4gICAgICAgICAgQXV0aC5tYXN0ZXIocmVxLmNvbmZpZyksXG4gICAgICAgICAgJ19TZXNzaW9uJyxcbiAgICAgICAgICByZWNvcmRzLnJlc3VsdHNbMF0ub2JqZWN0SWQsXG4gICAgICAgICAgcmVxLmluZm8uY29udGV4dFxuICAgICAgICApO1xuICAgICAgICBhd2FpdCBtYXliZVJ1blRyaWdnZXIoXG4gICAgICAgICAgVHJpZ2dlclR5cGVzLmFmdGVyTG9nb3V0LFxuICAgICAgICAgIHJlcS5hdXRoLFxuICAgICAgICAgIFBhcnNlLlNlc3Npb24uZnJvbUpTT04oT2JqZWN0LmFzc2lnbih7IGNsYXNzTmFtZTogJ19TZXNzaW9uJyB9LCByZWNvcmRzLnJlc3VsdHNbMF0pKSxcbiAgICAgICAgICBudWxsLFxuICAgICAgICAgIHJlcS5jb25maWdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHN1Y2Nlc3M7XG4gIH1cblxuICBfdGhyb3dPbkJhZEVtYWlsQ29uZmlnKHJlcSkge1xuICAgIHRyeSB7XG4gICAgICBDb25maWcudmFsaWRhdGVFbWFpbENvbmZpZ3VyYXRpb24oe1xuICAgICAgICBlbWFpbEFkYXB0ZXI6IHJlcS5jb25maWcudXNlckNvbnRyb2xsZXIuYWRhcHRlcixcbiAgICAgICAgYXBwTmFtZTogcmVxLmNvbmZpZy5hcHBOYW1lLFxuICAgICAgICBwdWJsaWNTZXJ2ZXJVUkw6IHJlcS5jb25maWcucHVibGljU2VydmVyVVJMIHx8IHJlcS5jb25maWcuX3B1YmxpY1NlcnZlclVSTCxcbiAgICAgICAgZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb246IHJlcS5jb25maWcuZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24sXG4gICAgICAgIGVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQ6IHJlcS5jb25maWcuZW1haWxWZXJpZnlUb2tlblJldXNlSWZWYWxpZCxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmICh0eXBlb2YgZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgLy8gTWF5YmUgd2UgbmVlZCBhIEJhZCBDb25maWd1cmF0aW9uIGVycm9yLCBidXQgdGhlIFNES3Mgd29uJ3QgdW5kZXJzdGFuZCBpdC4gRm9yIG5vdywgSW50ZXJuYWwgU2VydmVyIEVycm9yLlxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAgICdBbiBhcHBOYW1lLCBwdWJsaWNTZXJ2ZXJVUkwsIGFuZCBlbWFpbEFkYXB0ZXIgYXJlIHJlcXVpcmVkIGZvciBwYXNzd29yZCByZXNldCBhbmQgZW1haWwgdmVyaWZpY2F0aW9uIGZ1bmN0aW9uYWxpdHkuJ1xuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhc3luYyBoYW5kbGVSZXNldFJlcXVlc3QocmVxKSB7XG4gICAgdGhpcy5fdGhyb3dPbkJhZEVtYWlsQ29uZmlnKHJlcSk7XG5cbiAgICBsZXQgZW1haWwgPSByZXEuYm9keT8uZW1haWw7XG4gICAgY29uc3QgdG9rZW4gPSByZXEuYm9keT8udG9rZW47XG5cbiAgICBpZiAoIWVtYWlsICYmICF0b2tlbikge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX01JU1NJTkcsICd5b3UgbXVzdCBwcm92aWRlIGFuIGVtYWlsJyk7XG4gICAgfVxuXG4gICAgaWYgKHRva2VuICYmIHR5cGVvZiB0b2tlbiAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1ZBTFVFLCAndG9rZW4gbXVzdCBiZSBhIHN0cmluZycpO1xuICAgIH1cblxuICAgIGxldCB1c2VyUmVzdWx0cyA9IG51bGw7XG4gICAgbGV0IHVzZXJEYXRhID0gbnVsbDtcblxuICAgIC8vIFdlIGNhbiBmaW5kIHRoZSB1c2VyIHVzaW5nIHRva2VuXG4gICAgaWYgKHRva2VuKSB7XG4gICAgICB1c2VyUmVzdWx0cyA9IGF3YWl0IHJlcS5jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCB7XG4gICAgICAgIF9wZXJpc2hhYmxlX3Rva2VuOiB0b2tlbixcbiAgICAgICAgX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdDogeyAkbHQ6IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSkgfSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHVzZXJSZXN1bHRzPy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHVzZXJEYXRhID0gdXNlclJlc3VsdHNbMF07XG4gICAgICAgIGlmICh1c2VyRGF0YS5lbWFpbCkge1xuICAgICAgICAgIGVtYWlsID0gdXNlckRhdGEuZW1haWw7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAvLyBPciB1c2luZyBlbWFpbCBpZiBubyB0b2tlbiBwcm92aWRlZFxuICAgIH0gZWxzZSBpZiAodHlwZW9mIGVtYWlsID09PSAnc3RyaW5nJykge1xuICAgICAgdXNlclJlc3VsdHMgPSBhd2FpdCByZXEuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAgICdfVXNlcicsXG4gICAgICAgIHsgJG9yOiBbeyBlbWFpbCB9LCB7IHVzZXJuYW1lOiBlbWFpbCwgZW1haWw6IHsgJGV4aXN0czogZmFsc2UgfSB9XSB9LFxuICAgICAgICB7IGxpbWl0OiAxIH0sXG4gICAgICAgIEF1dGgubWFpbnRlbmFuY2UocmVxLmNvbmZpZylcbiAgICAgICk7XG4gICAgICBpZiAodXNlclJlc3VsdHM/Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgdXNlckRhdGEgPSB1c2VyUmVzdWx0c1swXTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGVtYWlsICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0VNQUlMX0FERFJFU1MsXG4gICAgICAgICd5b3UgbXVzdCBwcm92aWRlIGEgdmFsaWQgZW1haWwgc3RyaW5nJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAodXNlckRhdGEpIHtcbiAgICAgIHRoaXMuX3Nhbml0aXplQXV0aERhdGEodXNlckRhdGEpO1xuICAgICAgLy8gR2V0IGZpbGVzIGF0dGFjaGVkIHRvIHVzZXJcbiAgICAgIGF3YWl0IHJlcS5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QocmVxLmNvbmZpZywgdXNlckRhdGEpO1xuXG4gICAgICBjb25zdCB1c2VyID0gaW5mbGF0ZSgnX1VzZXInLCB1c2VyRGF0YSk7XG5cbiAgICAgIGF3YWl0IG1heWJlUnVuVHJpZ2dlcihcbiAgICAgICAgVHJpZ2dlclR5cGVzLmJlZm9yZVBhc3N3b3JkUmVzZXRSZXF1ZXN0LFxuICAgICAgICByZXEuYXV0aCxcbiAgICAgICAgdXNlcixcbiAgICAgICAgbnVsbCxcbiAgICAgICAgcmVxLmNvbmZpZyxcbiAgICAgICAgcmVxLmluZm8uY29udGV4dFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCB1c2VyQ29udHJvbGxlciA9IHJlcS5jb25maWcudXNlckNvbnRyb2xsZXI7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHVzZXJDb250cm9sbGVyLnNlbmRQYXNzd29yZFJlc2V0RW1haWwoZW1haWwpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVzcG9uc2U6IHt9LFxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmIChlcnIuY29kZSA9PT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICBpZiAocmVxLmNvbmZpZy5wYXNzd29yZFBvbGljeT8ucmVzZXRQYXNzd29yZFN1Y2Nlc3NPbkludmFsaWRFbWFpbCA/PyB0cnVlKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHJlc3BvbnNlOiB7fSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGVyci5tZXNzYWdlID0gYEEgdXNlciB3aXRoIHRoYXQgZW1haWwgZG9lcyBub3QgZXhpc3QuYDtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICBhc3luYyBoYW5kbGVWZXJpZmljYXRpb25FbWFpbFJlcXVlc3QocmVxKSB7XG4gICAgdGhpcy5fdGhyb3dPbkJhZEVtYWlsQ29uZmlnKHJlcSk7XG5cbiAgICBjb25zdCB7IGVtYWlsIH0gPSByZXEuYm9keSB8fCB7fTtcbiAgICBpZiAoIWVtYWlsKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRU1BSUxfTUlTU0lORywgJ3lvdSBtdXN0IHByb3ZpZGUgYW4gZW1haWwnKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBlbWFpbCAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9FTUFJTF9BRERSRVNTLFxuICAgICAgICAneW91IG11c3QgcHJvdmlkZSBhIHZhbGlkIGVtYWlsIHN0cmluZydcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgdmVyaWZ5RW1haWxTdWNjZXNzT25JbnZhbGlkRW1haWwgPSByZXEuY29uZmlnLmVtYWlsVmVyaWZ5U3VjY2Vzc09uSW52YWxpZEVtYWlsID8/IHRydWU7XG5cbiAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgcmVxLmNvbmZpZy5kYXRhYmFzZS5maW5kKCdfVXNlcicsIHsgZW1haWw6IGVtYWlsIH0sIHt9LCBBdXRoLm1haW50ZW5hbmNlKHJlcS5jb25maWcpKTtcbiAgICBpZiAoIXJlc3VsdHMubGVuZ3RoIHx8IHJlc3VsdHMubGVuZ3RoIDwgMSkge1xuICAgICAgaWYgKHZlcmlmeUVtYWlsU3VjY2Vzc09uSW52YWxpZEVtYWlsKSB7XG4gICAgICAgIHJldHVybiB7IHJlc3BvbnNlOiB7fSB9O1xuICAgICAgfVxuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX05PVF9GT1VORCwgYE5vIHVzZXIgZm91bmQgd2l0aCBlbWFpbCAke2VtYWlsfWApO1xuICAgIH1cbiAgICBjb25zdCB1c2VyID0gcmVzdWx0c1swXTtcblxuICAgIC8vIHJlbW92ZSBwYXNzd29yZCBmaWVsZCwgbWVzc2VzIHdpdGggc2F2aW5nIG9uIHBvc3RncmVzXG4gICAgZGVsZXRlIHVzZXIucGFzc3dvcmQ7XG5cbiAgICBpZiAodXNlci5lbWFpbFZlcmlmaWVkKSB7XG4gICAgICBpZiAodmVyaWZ5RW1haWxTdWNjZXNzT25JbnZhbGlkRW1haWwpIHtcbiAgICAgICAgcmV0dXJuIHsgcmVzcG9uc2U6IHt9IH07XG4gICAgICB9XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsIGBFbWFpbCAke2VtYWlsfSBpcyBhbHJlYWR5IHZlcmlmaWVkLmApO1xuICAgIH1cblxuICAgIGNvbnN0IHVzZXJDb250cm9sbGVyID0gcmVxLmNvbmZpZy51c2VyQ29udHJvbGxlcjtcbiAgICBjb25zdCBzZW5kID0gYXdhaXQgdXNlckNvbnRyb2xsZXIucmVnZW5lcmF0ZUVtYWlsVmVyaWZ5VG9rZW4odXNlciwgcmVxLmF1dGguaXNNYXN0ZXIsIHJlcS5hdXRoLmluc3RhbGxhdGlvbklkLCByZXEuaXApO1xuICAgIGlmIChzZW5kKSB7XG4gICAgICB1c2VyQ29udHJvbGxlci5zZW5kVmVyaWZpY2F0aW9uRW1haWwodXNlciwgcmVxKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgcmVzcG9uc2U6IHt9IH07XG4gIH1cblxuICBhc3luYyBoYW5kbGVDaGFsbGVuZ2UocmVxKSB7XG4gICAgY29uc3QgeyB1c2VybmFtZSwgZW1haWwsIHBhc3N3b3JkLCBhdXRoRGF0YSwgY2hhbGxlbmdlRGF0YSB9ID0gcmVxLmJvZHkgfHwge307XG5cbiAgICAvLyBpZiB1c2VybmFtZSBvciBlbWFpbCBwcm92aWRlZCB3aXRoIHBhc3N3b3JkIHRyeSB0byBhdXRoZW50aWNhdGUgdGhlIHVzZXIgYnkgdXNlcm5hbWVcbiAgICBsZXQgdXNlcjtcbiAgICBpZiAodXNlcm5hbWUgfHwgZW1haWwpIHtcbiAgICAgIGlmICghcGFzc3dvcmQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLk9USEVSX0NBVVNFLFxuICAgICAgICAgICdZb3UgcHJvdmlkZWQgdXNlcm5hbWUgb3IgZW1haWwsIHlvdSBuZWVkIHRvIGFsc28gcHJvdmlkZSBwYXNzd29yZC4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICB1c2VyID0gYXdhaXQgdGhpcy5fYXV0aGVudGljYXRlVXNlckZyb21SZXF1ZXN0KHJlcSk7XG4gICAgfVxuXG4gICAgaWYgKCFjaGFsbGVuZ2VEYXRhKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsICdOb3RoaW5nIHRvIGNoYWxsZW5nZS4nKTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGNoYWxsZW5nZURhdGEgIT09ICdvYmplY3QnKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsICdjaGFsbGVuZ2VEYXRhIHNob3VsZCBiZSBhbiBvYmplY3QuJyk7XG4gICAgfVxuXG4gICAgbGV0IHJlcXVlc3Q7XG4gICAgbGV0IHBhcnNlVXNlcjtcblxuICAgIC8vIFRyeSB0byBmaW5kIHVzZXIgYnkgYXV0aERhdGFcbiAgICBpZiAoYXV0aERhdGEpIHtcbiAgICAgIGlmICh0eXBlb2YgYXV0aERhdGEgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PVEhFUl9DQVVTRSwgJ2F1dGhEYXRhIHNob3VsZCBiZSBhbiBvYmplY3QuJyk7XG4gICAgICB9XG4gICAgICBpZiAodXNlcikge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsXG4gICAgICAgICAgJ1lvdSBjYW5ub3QgcHJvdmlkZSB1c2VybmFtZS9lbWFpbCBhbmQgYXV0aERhdGEsIG9ubHkgdXNlIG9uZSBpZGVudGlmaWNhdGlvbiBtZXRob2QuJ1xuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhhdXRoRGF0YSkpIHtcbiAgICAgICAgaWYgKGF1dGhEYXRhW2tleV0gIT09IG51bGwgJiYgKHR5cGVvZiBhdXRoRGF0YVtrZXldICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGF1dGhEYXRhW2tleV0pKSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9USEVSX0NBVVNFLFxuICAgICAgICAgICAgYGF1dGhEYXRhLiR7a2V5fSBzaG91bGQgYmUgYW4gb2JqZWN0LmBcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChPYmplY3Qua2V5cyhhdXRoRGF0YSkuZmlsdGVyKGtleSA9PiBhdXRoRGF0YVtrZXldICYmIGF1dGhEYXRhW2tleV0uaWQpLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLk9USEVSX0NBVVNFLFxuICAgICAgICAgICdZb3UgY2Fubm90IHByb3ZpZGUgbW9yZSB0aGFuIG9uZSBhdXRoRGF0YSBwcm92aWRlciB3aXRoIGFuIGlkLidcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IEF1dGguZmluZFVzZXJzV2l0aEF1dGhEYXRhKHJlcS5jb25maWcsIGF1dGhEYXRhKTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXN1bHRzWzBdIHx8IHJlc3VsdHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnVXNlciBub3QgZm91bmQuJyk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gRmluZCB0aGUgcHJvdmlkZXIgdXNlZCB0byBmaW5kIHRoZSB1c2VyXG4gICAgICAgIGNvbnN0IHByb3ZpZGVyID0gT2JqZWN0LmtleXMoYXV0aERhdGEpLmZpbmQoa2V5ID0+IGF1dGhEYXRhW2tleV0gJiYgYXV0aERhdGFba2V5XS5pZCk7XG5cbiAgICAgICAgcGFyc2VVc2VyID0gUGFyc2UuVXNlci5mcm9tSlNPTih7IGNsYXNzTmFtZTogJ19Vc2VyJywgLi4ucmVzdWx0c1swXSB9KTtcbiAgICAgICAgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodW5kZWZpbmVkLCByZXEuYXV0aCwgcGFyc2VVc2VyLCBwYXJzZVVzZXIsIHJlcS5jb25maWcpO1xuICAgICAgICByZXF1ZXN0LmlzQ2hhbGxlbmdlID0gdHJ1ZTtcbiAgICAgICAgLy8gVmFsaWRhdGUgYXV0aERhdGEgdXNlZCB0byBpZGVudGlmeSB0aGUgdXNlciB0byBhdm9pZCBicnV0ZS1mb3JjZSBhdHRhY2sgb24gYGlkYFxuICAgICAgICBjb25zdCB7IHZhbGlkYXRvciB9ID0gcmVxLmNvbmZpZy5hdXRoRGF0YU1hbmFnZXIuZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIocHJvdmlkZXIpO1xuICAgICAgICBjb25zdCB2YWxpZGF0b3JSZXNwb25zZSA9IGF3YWl0IHZhbGlkYXRvcihhdXRoRGF0YVtwcm92aWRlcl0sIHJlcSwgcGFyc2VVc2VyLCByZXF1ZXN0KTtcbiAgICAgICAgaWYgKHZhbGlkYXRvclJlc3BvbnNlICYmIHZhbGlkYXRvclJlc3BvbnNlLnZhbGlkYXRvcikge1xuICAgICAgICAgIGF3YWl0IHZhbGlkYXRvclJlc3BvbnNlLnZhbGlkYXRvcigpO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIFJld3JpdGUgdGhlIGVycm9yIHRvIGF2b2lkIGd1ZXNzIGlkIGF0dGFja1xuICAgICAgICBsb2dnZXIuZXJyb3IoZSk7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnVXNlciBub3QgZm91bmQuJyk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFwYXJzZVVzZXIpIHtcbiAgICAgIHBhcnNlVXNlciA9IHVzZXIgPyBQYXJzZS5Vc2VyLmZyb21KU09OKHsgY2xhc3NOYW1lOiAnX1VzZXInLCAuLi51c2VyIH0pIDogdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGlmICghcmVxdWVzdCkge1xuICAgICAgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodW5kZWZpbmVkLCByZXEuYXV0aCwgcGFyc2VVc2VyLCBwYXJzZVVzZXIsIHJlcS5jb25maWcpO1xuICAgICAgcmVxdWVzdC5pc0NoYWxsZW5nZSA9IHRydWU7XG4gICAgfVxuICAgIGNvbnN0IGFjYyA9IHt9O1xuICAgIC8vIEV4ZWN1dGUgY2hhbGxlbmdlIHN0ZXAtYnktc3RlcCB3aXRoIGNvbnNpc3RlbnQgb3JkZXIgZm9yIGJldHRlciBlcnJvciBmZWVkYmFja1xuICAgIC8vIGFuZCB0byBhdm9pZCB0byB0cmlnZ2VyIG90aGVycyBjaGFsbGVuZ2VzIGlmIG9uZSBvZiB0aGVtIGZhaWxzXG4gICAgZm9yIChjb25zdCBwcm92aWRlciBvZiBPYmplY3Qua2V5cyhjaGFsbGVuZ2VEYXRhKS5zb3J0KCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGF1dGhBZGFwdGVyID0gcmVxLmNvbmZpZy5hdXRoRGF0YU1hbmFnZXIuZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIocHJvdmlkZXIpO1xuICAgICAgICBpZiAoIWF1dGhBZGFwdGVyKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qge1xuICAgICAgICAgIGFkYXB0ZXI6IHsgY2hhbGxlbmdlIH0sXG4gICAgICAgIH0gPSBhdXRoQWRhcHRlcjtcbiAgICAgICAgaWYgKHR5cGVvZiBjaGFsbGVuZ2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBjb25zdCBwcm92aWRlckNoYWxsZW5nZVJlc3BvbnNlID0gYXdhaXQgY2hhbGxlbmdlKFxuICAgICAgICAgICAgY2hhbGxlbmdlRGF0YVtwcm92aWRlcl0sXG4gICAgICAgICAgICBhdXRoRGF0YSAmJiBhdXRoRGF0YVtwcm92aWRlcl0sXG4gICAgICAgICAgICByZXEuY29uZmlnLmF1dGhbcHJvdmlkZXJdLFxuICAgICAgICAgICAgcmVxdWVzdFxuICAgICAgICAgICk7XG4gICAgICAgICAgYWNjW3Byb3ZpZGVyXSA9IHByb3ZpZGVyQ2hhbGxlbmdlUmVzcG9uc2UgfHwgdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IGUgPSByZXNvbHZlRXJyb3IoZXJyLCB7XG4gICAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgICAgICBtZXNzYWdlOiAnQ2hhbGxlbmdlIGZhaWxlZC4gVW5rbm93biBlcnJvci4nLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgdXNlclN0cmluZyA9IHJlcS5hdXRoICYmIHJlcS5hdXRoLnVzZXIgPyByZXEuYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xuICAgICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICAgYEZhaWxlZCBydW5uaW5nIGF1dGggc3RlcCBjaGFsbGVuZ2UgZm9yICR7cHJvdmlkZXJ9IGZvciB1c2VyICR7dXNlclN0cmluZ30gd2l0aCBFcnJvcjogYCArXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShlKSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhdXRoZW50aWNhdGlvblN0ZXA6ICdjaGFsbGVuZ2UnLFxuICAgICAgICAgICAgZXJyb3I6IGUsXG4gICAgICAgICAgICB1c2VyOiB1c2VyU3RyaW5nLFxuICAgICAgICAgICAgcHJvdmlkZXIsXG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgICB0aHJvdyBlO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4geyByZXNwb25zZTogeyBjaGFsbGVuZ2VEYXRhOiBhY2MgfSB9O1xuICB9XG5cbiAgbW91bnRSb3V0ZXMoKSB7XG4gICAgdGhpcy5yb3V0ZSgnR0VUJywgJy91c2VycycsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVGaW5kKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvdXNlcnMnLCBwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3ksIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVDcmVhdGUocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdHRVQnLCAnL3VzZXJzL21lJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZU1lKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnR0VUJywgJy91c2Vycy86b2JqZWN0SWQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlR2V0KHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUFVUJywgJy91c2Vycy86b2JqZWN0SWQnLCBwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3ksIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVVcGRhdGUocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdERUxFVEUnLCAnL3VzZXJzLzpvYmplY3RJZCcsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVEZWxldGUocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdHRVQnLCAnL2xvZ2luJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUxvZ0luKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvbG9naW4nLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlTG9nSW4ocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdQT1NUJywgJy9sb2dpbkFzJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUxvZ0luQXMocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdQT1NUJywgJy9sb2dvdXQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlTG9nT3V0KHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvcmVxdWVzdFBhc3N3b3JkUmVzZXQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlUmVzZXRSZXF1ZXN0KHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvdmVyaWZpY2F0aW9uRW1haWxSZXF1ZXN0JywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZVZlcmlmaWNhdGlvbkVtYWlsUmVxdWVzdChyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ0dFVCcsICcvdmVyaWZ5UGFzc3dvcmQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlVmVyaWZ5UGFzc3dvcmQocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdQT1NUJywgJy92ZXJpZnlQYXNzd29yZCcsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVWZXJpZnlQYXNzd29yZChyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ1BPU1QnLCAnL2NoYWxsZW5nZScsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVDaGFsbGVuZ2UocmVxKTtcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBVc2Vyc1JvdXRlcjtcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBRUEsSUFBQUEsS0FBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsT0FBQSxHQUFBRixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUUsZUFBQSxHQUFBSCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUcsY0FBQSxHQUFBSixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUksS0FBQSxHQUFBTCxz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