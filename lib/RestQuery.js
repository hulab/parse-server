"use strict";

// An object that encapsulates everything we need to run a 'find'
// operation, encoded in the REST API format.

var SchemaController = require('./Controllers/SchemaController');
const DatabaseController = require('./Controllers/DatabaseController');
var Parse = require('parse/node').Parse;
var logger = require('./logger').default;
const triggers = require('./triggers');
const {
  continueWhile
} = require('parse/lib/node/promiseUtils');
const AlwaysSelectedKeys = ['objectId', 'createdAt', 'updatedAt', 'ACL'];
const {
  enforceRoleSecurity
} = require('./SharedRest');
const {
  createSanitizedError
} = require('./Error');
const Utils = require('./Utils');

// restOptions can include:
//   skip
//   limit
//   order
//   count
//   include
//   keys
//   excludeKeys
//   redirectClassNameForKey
//   readPreference
//   includeReadPreference
//   subqueryReadPreference
/**
 * Use to perform a query on a class. It will run security checks and triggers.
 * @param options
 * @param options.method {RestQuery.Method} The type of query to perform
 * @param options.config {ParseServerConfiguration} The server configuration
 * @param options.auth {Auth} The auth object for the request
 * @param options.className {string} The name of the class to query
 * @param options.restWhere {object} The where object for the query
 * @param options.restOptions {object} The options object for the query
 * @param options.runAfterFind {boolean} Whether to run the afterFind trigger
 * @param options.runBeforeFind {boolean} Whether to run the beforeFind trigger
 * @param options.context {object} The context object for the query
 * @returns {Promise<_UnsafeRestQuery>} A promise that is resolved with the _UnsafeRestQuery object
 */
async function RestQuery({
  method,
  config,
  auth,
  className,
  restWhere = {},
  restOptions = {},
  runAfterFind = true,
  runBeforeFind = true,
  context
}) {
  if (![RestQuery.Method.find, RestQuery.Method.get].includes(method)) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'bad query type');
  }
  const isGet = method === RestQuery.Method.get;
  enforceRoleSecurity(method, className, auth, config);
  const result = runBeforeFind ? await triggers.maybeRunQueryTrigger(triggers.Types.beforeFind, className, restWhere, restOptions, config, auth, context, isGet) : Promise.resolve({
    restWhere,
    restOptions
  });
  return new _UnsafeRestQuery(config, auth, className, result.restWhere || restWhere, result.restOptions || restOptions, runAfterFind, context, isGet);
}
RestQuery.Method = Object.freeze({
  get: 'get',
  find: 'find'
});

/**
 * _UnsafeRestQuery is meant for specific internal usage only. When you need to skip security checks or some triggers.
 * Don't use it if you don't know what you are doing.
 * @param config
 * @param auth
 * @param className
 * @param restWhere
 * @param restOptions
 * @param runAfterFind
 * @param context
 */
function _UnsafeRestQuery(config, auth, className, restWhere = {}, restOptions = {}, runAfterFind = true, context, isGet) {
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.restWhere = restWhere;
  this.restOptions = restOptions;
  this.runAfterFind = runAfterFind;
  this.response = null;
  this.findOptions = {};
  this.context = context || {};
  this.isGet = isGet;
  if (!this.auth.isMaster) {
    if (this.className == '_Session') {
      if (!this.auth.user) {
        throw createSanitizedError(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token', config);
      }
      this.restWhere = {
        $and: [this.restWhere, {
          user: {
            __type: 'Pointer',
            className: '_User',
            objectId: this.auth.user.id
          }
        }]
      };
    }
  }

  // Reject prohibited keywords in field paths
  for (const option of ['keys', 'excludeKeys', 'include']) {
    if (typeof restOptions[option] !== 'string') {
      continue;
    }
    // Field names have no value, so only key entries of the denylist match
    const fields = Object.fromEntries(restOptions[option].split(/[,.]/).map(name => [name, undefined]));
    try {
      Utils.checkProhibitedKeywords(config, fields);
    } catch (error) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, `${error}`);
    }
  }
  this.doCount = false;
  this.includeAll = false;

  // The format for this.include is not the same as the format for the
  // include option - it's the paths we should include, in order,
  // stored as arrays, taking into account that we need to include foo
  // before including foo.bar. Also it should dedupe.
  // For example, passing an arg of include=foo.bar,foo.baz could lead to
  // this.include = [['foo'], ['foo', 'baz'], ['foo', 'bar']]
  this.include = [];
  let keysForInclude = '';

  // If we have keys, we probably want to force some includes (n-1 level)
  // See issue: https://github.com/parse-community/parse-server/issues/3185
  if (Object.prototype.hasOwnProperty.call(restOptions, 'keys')) {
    keysForInclude = restOptions.keys;
  }

  // If we have keys, we probably want to force some includes (n-1 level)
  // in order to exclude specific keys.
  if (Object.prototype.hasOwnProperty.call(restOptions, 'excludeKeys')) {
    keysForInclude += ',' + restOptions.excludeKeys;
  }
  if (keysForInclude.length > 0) {
    keysForInclude = keysForInclude.split(',').filter(key => {
      // At least 2 components
      return key.split('.').length > 1;
    }).map(key => {
      // Slice the last component (a.b.c -> a.b)
      // Otherwise we'll include one level too much.
      return key.slice(0, key.lastIndexOf('.'));
    }).join(',');

    // Concat the possibly present include string with the one from the keys
    // Dedup / sorting is handle in 'include' case.
    if (keysForInclude.length > 0) {
      if (!restOptions.include || restOptions.include.length == 0) {
        restOptions.include = keysForInclude;
      } else {
        restOptions.include += ',' + keysForInclude;
      }
    }
  }
  for (var option in restOptions) {
    switch (option) {
      case 'keys':
        {
          const keys = restOptions.keys.split(',').filter(key => key.length > 0).concat(AlwaysSelectedKeys);
          this.keys = Array.from(new Set(keys));
          break;
        }
      case 'excludeKeys':
        {
          const exclude = restOptions.excludeKeys.split(',').filter(k => AlwaysSelectedKeys.indexOf(k) < 0);
          this.excludeKeys = Array.from(new Set(exclude));
          break;
        }
      case 'count':
        this.doCount = true;
        break;
      case 'includeAll':
        this.includeAll = true;
        break;
      case 'explain':
      case 'hint':
      case 'distinct':
      case 'pipeline':
      case 'skip':
      case 'limit':
      case 'readPreference':
      case 'comment':
      case 'rawValues':
      case 'rawFieldNames':
        this.findOptions[option] = restOptions[option];
        break;
      case 'order':
        var fields = restOptions.order.split(',');
        this.findOptions.sort = fields.reduce((sortMap, field) => {
          field = field.trim();
          if (field === '$score' || field === '-$score') {
            sortMap.score = {
              $meta: 'textScore'
            };
          } else if (field[0] == '-') {
            sortMap[field.slice(1)] = -1;
          } else {
            sortMap[field] = 1;
          }
          return sortMap;
        }, {});
        break;
      case 'include':
        {
          const paths = restOptions.include.split(',');
          if (paths.includes('*')) {
            this.includeAll = true;
            break;
          }
          // Load the existing includes (from keys)
          const pathSet = paths.reduce((memo, path) => {
            // Split each paths on . (a.b.c -> [a,b,c])
            // reduce to create all paths
            // ([a,b,c] -> {a: true, 'a.b': true, 'a.b.c': true})
            return path.split('.').reduce((memo, path, index, parts) => {
              memo[parts.slice(0, index + 1).join('.')] = true;
              return memo;
            }, memo);
          }, {});
          this.include = Object.keys(pathSet).map(s => {
            return s.split('.');
          }).sort((a, b) => {
            return a.length - b.length; // Sort by number of components
          });
          break;
        }
      case 'redirectClassNameForKey':
        this.redirectKey = restOptions.redirectClassNameForKey;
        this.redirectClassName = null;
        break;
      case 'includeReadPreference':
      case 'subqueryReadPreference':
        break;
      default:
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad option: ' + option);
    }
  }
}

// A convenient method to perform all the steps of processing a query
// in order.
// Returns a promise for the response - an object with optional keys
// 'results' and 'count'.
// TODO: consolidate the replaceX functions
_UnsafeRestQuery.prototype.execute = function (executeOptions) {
  return Promise.resolve().then(() => {
    return this.validateQueryDepth();
  }).then(() => {
    return this.buildRestWhere();
  }).then(() => {
    return this.denyProtectedFields();
  }).then(() => {
    return this.handleIncludeAll();
  }).then(() => {
    return this.validateIncludeComplexity();
  }).then(() => {
    return this.handleExcludeKeys();
  }).then(() => {
    return this.runFind(executeOptions);
  }).then(() => {
    return this.runCount();
  }).then(() => {
    return this.handleInclude();
  }).then(() => {
    return this.runAfterFindTrigger();
  }).then(() => {
    return this.handleAuthAdapters();
  }).then(() => {
    return this.response;
  });
};
_UnsafeRestQuery.prototype.each = function (callback) {
  const {
    config,
    auth,
    className,
    restWhere,
    restOptions
  } = this;
  // if the limit is set, use it
  restOptions.limit = restOptions.limit || 100;
  restOptions.order = 'objectId';
  let finished = false;
  return continueWhile(() => {
    return !finished;
  }, async () => {
    // Safe here to use _UnsafeRestQuery because the security was already
    // checked during "await RestQuery()"
    const query = new _UnsafeRestQuery(config, auth, className, restWhere, restOptions, this.runAfterFind, this.context);
    const {
      results
    } = await query.execute();
    results.forEach(callback);
    finished = results.length < restOptions.limit;
    if (!finished) {
      restWhere.objectId = Object.assign({}, restWhere.objectId, {
        $gt: results[results.length - 1].objectId
      });
    }
  });
};
_UnsafeRestQuery.prototype.validateQueryDepth = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  const rc = this.config.requestComplexity;
  if (!rc || rc.queryDepth === -1) {
    return;
  }
  const maxDepth = rc.queryDepth;
  const checkDepth = (node, depth) => {
    if (depth > maxDepth) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, `Query condition nesting depth exceeds maximum allowed depth of ${maxDepth}`);
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        checkDepth(item, depth);
      }
      return;
    }
    // Descend into every value so that logical operators ($or/$and/$nor) nested
    // under field-level operators (e.g. $elemMatch, $not) or plain field names are
    // still counted. Only logical operators increase the depth, which preserves the
    // documented meaning of `queryDepth`.
    for (const key of Object.keys(node)) {
      const isLogical = key === '$or' || key === '$and' || key === '$nor';
      checkDepth(node[key], isLogical ? depth + 1 : depth);
    }
  };
  checkDepth(this.restWhere, 0);
};

// Validates the format of the where clause before it is processed
_UnsafeRestQuery.prototype.validateQueryFormat = function () {
  DatabaseController.validateQueryFormat(this.restWhere);
};
_UnsafeRestQuery.prototype.buildRestWhere = function () {
  return Promise.resolve().then(() => {
    return this.validateQueryFormat();
  }).then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.redirectClassNameForKey();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.checkSubqueryDepth();
  }).then(() => {
    return this.replaceSelect();
  }).then(() => {
    return this.replaceDontSelect();
  }).then(() => {
    return this.replaceInQuery();
  }).then(() => {
    return this.replaceNotInQuery();
  }).then(() => {
    return this.replaceEquality();
  });
};

// Uses the Auth object to get the list of roles, adds the user id
_UnsafeRestQuery.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster) {
    return Promise.resolve();
  }
  this.findOptions.acl = ['*'];
  if (this.auth.user) {
    return this.auth.getUserRoles().then(roles => {
      this.findOptions.acl = this.findOptions.acl.concat(roles, [this.auth.user.id]);
      return;
    });
  } else {
    return Promise.resolve();
  }
};

// Changes the className if redirectClassNameForKey is set.
// Returns a promise.
_UnsafeRestQuery.prototype.redirectClassNameForKey = function () {
  if (!this.redirectKey) {
    return Promise.resolve();
  }

  // We need to change the class name based on the schema
  return this.config.database.redirectClassNameForKey(this.className, this.redirectKey).then(newClassName => {
    this.className = newClassName;
    this.redirectClassName = newClassName;

    // Re-apply security checks for the redirected class name, since the
    // checks in the constructor and in rest.find ran against the original
    // class name before the redirect.
    if (!this.auth.isMaster) {
      enforceRoleSecurity('find', this.className, this.auth, this.config);
      if (this.className === '_Session') {
        if (!this.auth.user) {
          throw createSanitizedError(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token', this.config);
        }
        this.restWhere = {
          $and: [this.restWhere, {
            user: {
              __type: 'Pointer',
              className: '_User',
              objectId: this.auth.user.id
            }
          }]
        };
      }
    }
  });
};

// Validates this operation against the allowClientClassCreation config.
_UnsafeRestQuery.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw createSanitizedError(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className, this.config);
      }
    });
  } else {
    return Promise.resolve();
  }
};
function transformInQuery(inQueryObject, className, results) {
  var values = [];
  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }
  delete inQueryObject['$inQuery'];
  if (Array.isArray(inQueryObject['$in'])) {
    inQueryObject['$in'] = inQueryObject['$in'].concat(values);
  } else {
    inQueryObject['$in'] = values;
  }
}
_UnsafeRestQuery.prototype.checkSubqueryDepth = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  const rc = this.config.requestComplexity;
  if (!rc || rc.subqueryDepth === -1) {
    return;
  }
  const depth = this.context._subqueryDepth || 0;
  if (depth > rc.subqueryDepth) {
    const message = `Subquery nesting depth exceeds maximum allowed depth of ${rc.subqueryDepth}`;
    logger.warn(message);
    throw new Parse.Error(Parse.Error.INVALID_QUERY, message);
  }
};

// Replaces a $inQuery clause by running the subquery, if there is an
// $inQuery clause.
// The $inQuery clause turns into an $in with values that are just
// pointers to the objects returned in the subquery.
_UnsafeRestQuery.prototype.replaceInQuery = async function () {
  var inQueryObject = findObjectWithKey(this.restWhere, '$inQuery');
  if (!inQueryObject) {
    return;
  }

  // The inQuery value must have precisely two keys - where and className
  var inQueryValue = inQueryObject['$inQuery'];
  if (!inQueryValue.where || !inQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $inQuery');
  }
  const additionalOptions = {
    redirectClassNameForKey: inQueryValue.redirectClassNameForKey
  };
  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }
  if (!this.auth.isMaster && !this.auth.isMaintenance) {
    const rc = this.config.requestComplexity;
    if (rc && rc.subqueryLimit > 0) {
      additionalOptions.limit = rc.subqueryLimit;
    }
  }
  const childContext = {
    ...this.context,
    _subqueryDepth: (this.context._subqueryDepth || 0) + 1
  };
  const subquery = await RestQuery({
    method: RestQuery.Method.find,
    config: this.config,
    auth: this.auth,
    className: inQueryValue.className,
    restWhere: inQueryValue.where,
    restOptions: additionalOptions,
    context: childContext
  });
  return subquery.execute().then(response => {
    transformInQuery(inQueryObject, subquery.className, response.results);
    // Recurse to repeat
    return this.replaceInQuery();
  });
};
function transformNotInQuery(notInQueryObject, className, results) {
  var values = [];
  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }
  delete notInQueryObject['$notInQuery'];
  if (Array.isArray(notInQueryObject['$nin'])) {
    notInQueryObject['$nin'] = notInQueryObject['$nin'].concat(values);
  } else {
    notInQueryObject['$nin'] = values;
  }
}

// Replaces a $notInQuery clause by running the subquery, if there is an
// $notInQuery clause.
// The $notInQuery clause turns into a $nin with values that are just
// pointers to the objects returned in the subquery.
_UnsafeRestQuery.prototype.replaceNotInQuery = async function () {
  var notInQueryObject = findObjectWithKey(this.restWhere, '$notInQuery');
  if (!notInQueryObject) {
    return;
  }

  // The notInQuery value must have precisely two keys - where and className
  var notInQueryValue = notInQueryObject['$notInQuery'];
  if (!notInQueryValue.where || !notInQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $notInQuery');
  }
  const additionalOptions = {
    redirectClassNameForKey: notInQueryValue.redirectClassNameForKey
  };
  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }
  if (!this.auth.isMaster && !this.auth.isMaintenance) {
    const rc = this.config.requestComplexity;
    if (rc && rc.subqueryLimit > 0) {
      additionalOptions.limit = rc.subqueryLimit;
    }
  }
  const childContext = {
    ...this.context,
    _subqueryDepth: (this.context._subqueryDepth || 0) + 1
  };
  const subquery = await RestQuery({
    method: RestQuery.Method.find,
    config: this.config,
    auth: this.auth,
    className: notInQueryValue.className,
    restWhere: notInQueryValue.where,
    restOptions: additionalOptions,
    context: childContext
  });
  return subquery.execute().then(response => {
    transformNotInQuery(notInQueryObject, subquery.className, response.results);
    // Recurse to repeat
    return this.replaceNotInQuery();
  });
};

// Used to get the deepest object from json using dot notation.
const getDeepestObjectFromKey = (json, key, idx, src) => {
  if (key in json) {
    return json[key];
  }
  src.splice(1); // Exit Early
};
const transformSelect = (selectObject, key, objects) => {
  var values = [];
  for (var result of objects) {
    values.push(key.split('.').reduce(getDeepestObjectFromKey, result));
  }
  delete selectObject['$select'];
  if (Array.isArray(selectObject['$in'])) {
    selectObject['$in'] = selectObject['$in'].concat(values);
  } else {
    selectObject['$in'] = values;
  }
};

// Replaces a $select clause by running the subquery, if there is a
// $select clause.
// The $select clause turns into an $in with values selected out of
// the subquery.
// Returns a possible-promise.
_UnsafeRestQuery.prototype.replaceSelect = async function () {
  var selectObject = findObjectWithKey(this.restWhere, '$select');
  if (!selectObject) {
    return;
  }

  // The select value must have precisely two keys - query and key
  var selectValue = selectObject['$select'];
  // iOS SDK don't send where if not set, let it pass
  if (!selectValue.query || !selectValue.key || typeof selectValue.query !== 'object' || !selectValue.query.className || Object.keys(selectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $select');
  }
  const additionalOptions = {
    redirectClassNameForKey: selectValue.query.redirectClassNameForKey
  };
  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }
  if (!this.auth.isMaster && !this.auth.isMaintenance) {
    const rc = this.config.requestComplexity;
    if (rc && rc.subqueryLimit > 0) {
      additionalOptions.limit = rc.subqueryLimit;
    }
  }
  const childContext = {
    ...this.context,
    _subqueryDepth: (this.context._subqueryDepth || 0) + 1
  };
  const subquery = await RestQuery({
    method: RestQuery.Method.find,
    config: this.config,
    auth: this.auth,
    className: selectValue.query.className,
    restWhere: selectValue.query.where,
    restOptions: additionalOptions,
    context: childContext
  });
  return subquery.execute().then(response => {
    transformSelect(selectObject, selectValue.key, response.results);
    // Keep replacing $select clauses
    return this.replaceSelect();
  });
};
const transformDontSelect = (dontSelectObject, key, objects) => {
  var values = [];
  for (var result of objects) {
    values.push(key.split('.').reduce(getDeepestObjectFromKey, result));
  }
  delete dontSelectObject['$dontSelect'];
  if (Array.isArray(dontSelectObject['$nin'])) {
    dontSelectObject['$nin'] = dontSelectObject['$nin'].concat(values);
  } else {
    dontSelectObject['$nin'] = values;
  }
};

// Replaces a $dontSelect clause by running the subquery, if there is a
// $dontSelect clause.
// The $dontSelect clause turns into an $nin with values selected out of
// the subquery.
// Returns a possible-promise.
_UnsafeRestQuery.prototype.replaceDontSelect = async function () {
  var dontSelectObject = findObjectWithKey(this.restWhere, '$dontSelect');
  if (!dontSelectObject) {
    return;
  }

  // The dontSelect value must have precisely two keys - query and key
  var dontSelectValue = dontSelectObject['$dontSelect'];
  if (!dontSelectValue.query || !dontSelectValue.key || typeof dontSelectValue.query !== 'object' || !dontSelectValue.query.className || Object.keys(dontSelectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $dontSelect');
  }
  const additionalOptions = {
    redirectClassNameForKey: dontSelectValue.query.redirectClassNameForKey
  };
  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }
  if (!this.auth.isMaster && !this.auth.isMaintenance) {
    const rc = this.config.requestComplexity;
    if (rc && rc.subqueryLimit > 0) {
      additionalOptions.limit = rc.subqueryLimit;
    }
  }
  const childContext = {
    ...this.context,
    _subqueryDepth: (this.context._subqueryDepth || 0) + 1
  };
  const subquery = await RestQuery({
    method: RestQuery.Method.find,
    config: this.config,
    auth: this.auth,
    className: dontSelectValue.query.className,
    restWhere: dontSelectValue.query.where,
    restOptions: additionalOptions,
    context: childContext
  });
  return subquery.execute().then(response => {
    transformDontSelect(dontSelectObject, dontSelectValue.key, response.results);
    // Keep replacing $dontSelect clauses
    return this.replaceDontSelect();
  });
};
_UnsafeRestQuery.prototype.cleanResultAuthData = function (result) {
  delete result.password;
  if (result.authData) {
    Object.keys(result.authData).forEach(provider => {
      if (result.authData[provider] === null) {
        delete result.authData[provider];
      }
    });
    if (Object.keys(result.authData).length == 0) {
      delete result.authData;
    }
  }
};
const replaceEqualityConstraint = constraint => {
  if (typeof constraint !== 'object') {
    return constraint;
  }
  const equalToObject = {};
  let hasDirectConstraint = false;
  let hasOperatorConstraint = false;
  for (const key in constraint) {
    if (key.indexOf('$') !== 0) {
      hasDirectConstraint = true;
      equalToObject[key] = constraint[key];
    } else {
      hasOperatorConstraint = true;
    }
  }
  if (hasDirectConstraint && hasOperatorConstraint) {
    constraint['$eq'] = equalToObject;
    Object.keys(equalToObject).forEach(key => {
      delete constraint[key];
    });
  }
  return constraint;
};
_UnsafeRestQuery.prototype.replaceEquality = function () {
  if (typeof this.restWhere !== 'object') {
    return;
  }
  for (const key in this.restWhere) {
    this.restWhere[key] = replaceEqualityConstraint(this.restWhere[key]);
  }
};

// Returns a promise for whether it was successful.
// Populates this.response with an object that only has 'results'.
_UnsafeRestQuery.prototype.runFind = async function (options = {}) {
  if (this.findOptions.limit === 0) {
    this.response = {
      results: []
    };
    return Promise.resolve();
  }
  const findOptions = Object.assign({}, this.findOptions);
  if (this.keys) {
    findOptions.keys = this.keys.map(key => {
      return key.split('.')[0];
    });
    // When selecting `authData` on `_User`, also add the internal auth data fields
    // (e.g. `_auth_data_facebook`) for each configured auth provider. In MongoDB,
    // `authData` is stored as individual `_auth_data_<provider>` fields, so the
    // projection for `authData` alone won't match them. Adding both ensures it
    // works across all database adapters: Mongo uses `_auth_data_*` fields,
    // Postgres uses the `authData` column directly.
    //
    // Note: When selecting `authData`, only auth data of currently configured
    // providers is returned. Auth data entries of providers that are no longer
    // configured won't be included. To return all auth data regardless of the
    // provider configuration, do not use `authData` as a selected key.
    if (this.className === '_User' && findOptions.keys.includes('authData')) {
      const providers = this.config.authDataManager.getProviders();
      for (const provider of providers) {
        const key = `_auth_data_${provider}`;
        if (!findOptions.keys.includes(key)) {
          findOptions.keys.push(key);
        }
      }
    }
  }
  if (options.op) {
    findOptions.op = options.op;
  }
  const results = await this.config.database.find(this.className, this.restWhere, findOptions, this.auth);
  if (this.className === '_User' && !findOptions.explain) {
    for (var result of results) {
      this.cleanResultAuthData(result);
    }
  }
  await this.config.filesController.expandFilesInObject(this.config, results);
  if (this.redirectClassName) {
    for (var r of results) {
      r.className = this.redirectClassName;
    }
  }
  this.response = {
    results: results
  };
};

// Returns a promise for whether it was successful.
// Populates this.response.count with the count
_UnsafeRestQuery.prototype.runCount = function () {
  if (!this.doCount) {
    return;
  }
  this.findOptions.count = true;
  delete this.findOptions.skip;
  delete this.findOptions.limit;
  return this.config.database.find(this.className, this.restWhere, this.findOptions, this.auth).then(c => {
    this.response.count = c;
  });
};
_UnsafeRestQuery.prototype.denyProtectedFields = async function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  const schemaController = await this.config.database.loadSchema();
  const protectedFields = this.config.database.addProtectedFields(schemaController, this.className, this.restWhere, this.findOptions.acl, this.auth, this.findOptions) || [];
  const checkWhere = where => {
    if (typeof where !== 'object' || where === null) {
      return;
    }
    for (const whereKey of Object.keys(where)) {
      const rootField = whereKey.split('.')[0];
      if (protectedFields.includes(whereKey) || protectedFields.includes(rootField)) {
        throw createSanitizedError(Parse.Error.OPERATION_FORBIDDEN, `This user is not allowed to query ${whereKey} on class ${this.className}`, this.config);
      }
    }
    for (const op of ['$or', '$and', '$nor']) {
      if (where[op] !== undefined && !Array.isArray(where[op])) {
        throw DatabaseController.logicalOperatorError(op, where[op]);
      }
      if (Array.isArray(where[op])) {
        where[op].forEach(subQuery => checkWhere(subQuery));
      }
    }
  };
  checkWhere(this.restWhere);

  // Check sort keys against protected fields
  if (this.findOptions.sort) {
    for (const sortKey of Object.keys(this.findOptions.sort)) {
      const rootField = sortKey.split('.')[0];
      if (protectedFields.includes(sortKey) || protectedFields.includes(rootField)) {
        throw createSanitizedError(Parse.Error.OPERATION_FORBIDDEN, `This user is not allowed to sort by ${sortKey} on class ${this.className}`, this.config);
      }
    }
  }
};

// Augments this.response with all pointers on an object
_UnsafeRestQuery.prototype.handleIncludeAll = function () {
  if (!this.includeAll) {
    return;
  }
  return this.config.database.loadSchema().then(schemaController => schemaController.getOneSchema(this.className)).then(schema => {
    const includeFields = [];
    const keyFields = [];
    for (const field in schema.fields) {
      if (schema.fields[field].type && schema.fields[field].type === 'Pointer' || schema.fields[field].type && schema.fields[field].type === 'Array') {
        includeFields.push([field]);
        keyFields.push(field);
      }
    }
    // Add fields to include, keys, remove dups
    this.include = [...new Set([...this.include, ...includeFields])];
    // if this.keys not set, then all keys are already included
    if (this.keys) {
      this.keys = [...new Set([...this.keys, ...keyFields])];
    }
  });
};
_UnsafeRestQuery.prototype.validateIncludeComplexity = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  const rc = this.config.requestComplexity;
  if (!rc) {
    return;
  }
  if (rc.includeDepth !== -1 && this.include && this.include.length > 0) {
    const maxDepth = Math.max(...this.include.map(path => path.length));
    if (maxDepth > rc.includeDepth) {
      const message = `Include depth of ${maxDepth} exceeds maximum allowed depth of ${rc.includeDepth}`;
      logger.warn(message);
      throw new Parse.Error(Parse.Error.INVALID_QUERY, message);
    }
  }
  if (rc.includeCount !== -1 && this.include && this.include.length > rc.includeCount) {
    const message = `Number of include fields (${this.include.length}) exceeds maximum allowed (${rc.includeCount})`;
    logger.warn(message);
    throw new Parse.Error(Parse.Error.INVALID_QUERY, message);
  }
};

// Updates property `this.keys` to contain all keys but the ones unselected.
_UnsafeRestQuery.prototype.handleExcludeKeys = function () {
  if (!this.excludeKeys) {
    return;
  }
  if (this.keys) {
    this.keys = this.keys.filter(k => !this.excludeKeys.includes(k));
    return;
  }
  return this.config.database.loadSchema().then(schemaController => schemaController.getOneSchema(this.className)).then(schema => {
    const fields = Object.keys(schema.fields);
    this.keys = fields.filter(k => !this.excludeKeys.includes(k));
  });
};

// Augments this.response with data at the paths provided in this.include.
_UnsafeRestQuery.prototype.handleInclude = async function () {
  if (this.include.length == 0) {
    return;
  }
  const indexedResults = this.response.results.reduce((indexed, result, i) => {
    indexed[result.objectId] = i;
    return indexed;
  }, {});

  // Build the execution tree
  const executionTree = {};
  this.include.forEach(path => {
    let current = executionTree;
    path.forEach(node => {
      if (!current[node]) {
        current[node] = {
          path,
          children: {}
        };
      }
      current = current[node].children;
    });
  });
  const recursiveExecutionTree = async treeNode => {
    const {
      path,
      children
    } = treeNode;
    const pathResponse = includePath(this.config, this.auth, this.response, path, this.context, this.restOptions, this);
    if (pathResponse.then) {
      const newResponse = await pathResponse;
      newResponse.results.forEach(newObject => {
        // We hydrate the root of each result with sub results
        this.response.results[indexedResults[newObject.objectId]][path[0]] = newObject[path[0]];
      });
    }
    return Promise.all(Object.values(children).map(recursiveExecutionTree));
  };
  await Promise.all(Object.values(executionTree).map(recursiveExecutionTree));
  this.include = [];
};

//Returns a promise of a processed set of results
_UnsafeRestQuery.prototype.runAfterFindTrigger = function () {
  if (!this.response) {
    return;
  }
  if (!this.runAfterFind) {
    return;
  }
  // Avoid doing any setup for triggers if there is no 'afterFind' trigger for this class.
  const hasAfterFindHook = triggers.triggerExists(this.className, triggers.Types.afterFind, this.config.applicationId);
  if (!hasAfterFindHook) {
    return Promise.resolve();
  }
  // Skip Aggregate, Distinct and Explain Queries
  if (this.findOptions.pipeline || this.findOptions.distinct || this.findOptions.explain) {
    return Promise.resolve();
  }
  const json = Object.assign({}, this.restOptions);
  json.where = this.restWhere;
  const parseQuery = new Parse.Query(this.className);
  parseQuery.withJSON(json);
  // Run afterFind trigger and set the new results
  return triggers.maybeRunAfterFindTrigger(triggers.Types.afterFind, this.auth, this.className, this.response.results, this.config, parseQuery, this.context, this.isGet).then(results => {
    // Ensure we properly set the className back
    if (this.redirectClassName) {
      this.response.results = results.map(object => {
        if (object instanceof Parse.Object) {
          object = object.toJSON();
        }
        object.className = this.redirectClassName;
        return object;
      });
    } else {
      this.response.results = results;
    }
  });
};
_UnsafeRestQuery.prototype.handleAuthAdapters = async function () {
  if (this.className !== '_User' || this.findOptions.explain) {
    return;
  }
  await Promise.all(this.response.results.map(result => this.config.authDataManager.runAfterFind({
    config: this.config,
    auth: this.auth
  }, result.authData)));
};

// Adds included values to the response.
// Path is a list of field names.
// Returns a promise for an augmented response.
function includePath(config, auth, response, path, context, restOptions = {}) {
  var pointers = findPointers(response.results, path);
  if (pointers.length == 0) {
    return response;
  }
  const pointersHash = {};
  for (var pointer of pointers) {
    if (!pointer) {
      continue;
    }
    const className = pointer.className;
    // only include the good pointers
    if (className) {
      pointersHash[className] = pointersHash[className] || new Set();
      pointersHash[className].add(pointer.objectId);
    }
  }
  const includeRestOptions = {};
  if (restOptions.keys) {
    const keys = new Set(restOptions.keys.split(','));
    const keySet = Array.from(keys).reduce((set, key) => {
      const keyPath = key.split('.');
      let i = 0;
      for (i; i < path.length; i++) {
        if (path[i] != keyPath[i]) {
          return set;
        }
      }
      if (i < keyPath.length) {
        set.add(keyPath[i]);
      }
      return set;
    }, new Set());
    if (keySet.size > 0) {
      includeRestOptions.keys = Array.from(keySet).join(',');
    }
  }
  if (restOptions.excludeKeys) {
    const excludeKeys = new Set(restOptions.excludeKeys.split(','));
    const excludeKeySet = Array.from(excludeKeys).reduce((set, key) => {
      const keyPath = key.split('.');
      let i = 0;
      for (i; i < path.length; i++) {
        if (path[i] != keyPath[i]) {
          return set;
        }
      }
      if (i == keyPath.length - 1) {
        set.add(keyPath[i]);
      }
      return set;
    }, new Set());
    if (excludeKeySet.size > 0) {
      includeRestOptions.excludeKeys = Array.from(excludeKeySet).join(',');
    }
  }
  if (restOptions.includeReadPreference) {
    includeRestOptions.readPreference = restOptions.includeReadPreference;
    includeRestOptions.includeReadPreference = restOptions.includeReadPreference;
  } else if (restOptions.readPreference) {
    includeRestOptions.readPreference = restOptions.readPreference;
  }
  const queryPromises = Object.keys(pointersHash).map(async className => {
    const objectIds = Array.from(pointersHash[className]);
    let where;
    if (objectIds.length === 1) {
      where = {
        objectId: objectIds[0]
      };
    } else {
      where = {
        objectId: {
          $in: objectIds
        }
      };
    }
    const query = await RestQuery({
      method: objectIds.length === 1 ? RestQuery.Method.get : RestQuery.Method.find,
      config,
      auth,
      className,
      restWhere: where,
      restOptions: includeRestOptions,
      context: context
    });
    return query.execute({
      op: 'get'
    }).then(results => {
      results.className = className;
      return Promise.resolve(results);
    });
  });

  // Get the objects for all these object ids
  return Promise.all(queryPromises).then(responses => {
    var replace = responses.reduce((replace, includeResponse) => {
      for (var obj of includeResponse.results) {
        obj.__type = 'Object';
        obj.className = includeResponse.className;
        if (obj.className == '_User' && !auth.isMaster) {
          delete obj.sessionToken;
          delete obj.authData;
        }
        replace[obj.objectId] = obj;
      }
      return replace;
    }, {});
    var resp = {
      results: replacePointers(response.results, path, replace)
    };
    if (response.count) {
      resp.count = response.count;
    }
    return resp;
  });
}

// Object may be a list of REST-format object to find pointers in, or
// it may be a single object.
// If the path yields things that aren't pointers, this throws an error.
// Path is a list of fields to search into.
// Returns a list of pointers in REST format.
function findPointers(object, path) {
  if (Array.isArray(object)) {
    return object.map(x => findPointers(x, path)).flat();
  }
  if (typeof object !== 'object' || !object) {
    return [];
  }
  if (path.length == 0) {
    if (object === null || object.__type == 'Pointer') {
      return [object];
    }
    return [];
  }
  var subobject = object[path[0]];
  if (!subobject) {
    return [];
  }
  return findPointers(subobject, path.slice(1));
}

// Object may be a list of REST-format objects to replace pointers
// in, or it may be a single object.
// Path is a list of fields to search into.
// replace is a map from object id -> object.
// Returns something analogous to object, but with the appropriate
// pointers inflated.
function replacePointers(object, path, replace) {
  if (Array.isArray(object)) {
    return object.map(obj => replacePointers(obj, path, replace)).filter(obj => typeof obj !== 'undefined');
  }
  if (typeof object !== 'object' || !object) {
    return object;
  }
  if (path.length === 0) {
    if (object && object.__type === 'Pointer') {
      return replace[object.objectId];
    }
    return object;
  }
  var subobject = object[path[0]];
  if (!subobject) {
    return object;
  }
  var newsub = replacePointers(subobject, path.slice(1), replace);
  var answer = {};
  for (var key in object) {
    if (key == path[0]) {
      answer[key] = newsub;
    } else {
      answer[key] = object[key];
    }
  }
  return answer;
}

// Finds a subobject that has the given key, if there is one.
// Returns undefined otherwise.
function findObjectWithKey(root, key) {
  if (typeof root !== 'object') {
    return;
  }
  if (Array.isArray(root)) {
    for (var item of root) {
      const answer = findObjectWithKey(item, key);
      if (answer) {
        return answer;
      }
    }
    // Arrays are fully traversed above; returning here avoids re-walking the same
    // elements through the `for (subkey in root)` loop below, which would make this
    // function O(2^n) for nested arrays (e.g. deeply nested $or/$and/$nor).
    return;
  }
  if (root && root[key]) {
    return root;
  }
  for (var subkey in root) {
    const answer = findObjectWithKey(root[subkey], key);
    if (answer) {
      return answer;
    }
  }
}
module.exports = RestQuery;
// For tests
module.exports._UnsafeRestQuery = _UnsafeRestQuery;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJTY2hlbWFDb250cm9sbGVyIiwicmVxdWlyZSIsIkRhdGFiYXNlQ29udHJvbGxlciIsIlBhcnNlIiwibG9nZ2VyIiwiZGVmYXVsdCIsInRyaWdnZXJzIiwiY29udGludWVXaGlsZSIsIkFsd2F5c1NlbGVjdGVkS2V5cyIsImVuZm9yY2VSb2xlU2VjdXJpdHkiLCJjcmVhdGVTYW5pdGl6ZWRFcnJvciIsIlV0aWxzIiwiUmVzdFF1ZXJ5IiwibWV0aG9kIiwiY29uZmlnIiwiYXV0aCIsImNsYXNzTmFtZSIsInJlc3RXaGVyZSIsInJlc3RPcHRpb25zIiwicnVuQWZ0ZXJGaW5kIiwicnVuQmVmb3JlRmluZCIsImNvbnRleHQiLCJNZXRob2QiLCJmaW5kIiwiZ2V0IiwiaW5jbHVkZXMiLCJFcnJvciIsIklOVkFMSURfUVVFUlkiLCJpc0dldCIsInJlc3VsdCIsIm1heWJlUnVuUXVlcnlUcmlnZ2VyIiwiVHlwZXMiLCJiZWZvcmVGaW5kIiwiUHJvbWlzZSIsInJlc29sdmUiLCJfVW5zYWZlUmVzdFF1ZXJ5IiwiT2JqZWN0IiwiZnJlZXplIiwicmVzcG9uc2UiLCJmaW5kT3B0aW9ucyIsImlzTWFzdGVyIiwidXNlciIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsIiRhbmQiLCJfX3R5cGUiLCJvYmplY3RJZCIsImlkIiwib3B0aW9uIiwiZmllbGRzIiwiZnJvbUVudHJpZXMiLCJzcGxpdCIsIm1hcCIsIm5hbWUiLCJ1bmRlZmluZWQiLCJjaGVja1Byb2hpYml0ZWRLZXl3b3JkcyIsImVycm9yIiwiSU5WQUxJRF9LRVlfTkFNRSIsImRvQ291bnQiLCJpbmNsdWRlQWxsIiwiaW5jbHVkZSIsImtleXNGb3JJbmNsdWRlIiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwia2V5cyIsImV4Y2x1ZGVLZXlzIiwibGVuZ3RoIiwiZmlsdGVyIiwia2V5Iiwic2xpY2UiLCJsYXN0SW5kZXhPZiIsImpvaW4iLCJjb25jYXQiLCJBcnJheSIsImZyb20iLCJTZXQiLCJleGNsdWRlIiwiayIsImluZGV4T2YiLCJvcmRlciIsInNvcnQiLCJyZWR1Y2UiLCJzb3J0TWFwIiwiZmllbGQiLCJ0cmltIiwic2NvcmUiLCIkbWV0YSIsInBhdGhzIiwicGF0aFNldCIsIm1lbW8iLCJwYXRoIiwiaW5kZXgiLCJwYXJ0cyIsInMiLCJhIiwiYiIsInJlZGlyZWN0S2V5IiwicmVkaXJlY3RDbGFzc05hbWVGb3JLZXkiLCJyZWRpcmVjdENsYXNzTmFtZSIsIklOVkFMSURfSlNPTiIsImV4ZWN1dGUiLCJleGVjdXRlT3B0aW9ucyIsInRoZW4iLCJ2YWxpZGF0ZVF1ZXJ5RGVwdGgiLCJidWlsZFJlc3RXaGVyZSIsImRlbnlQcm90ZWN0ZWRGaWVsZHMiLCJoYW5kbGVJbmNsdWRlQWxsIiwidmFsaWRhdGVJbmNsdWRlQ29tcGxleGl0eSIsImhhbmRsZUV4Y2x1ZGVLZXlzIiwicnVuRmluZCIsInJ1bkNvdW50IiwiaGFuZGxlSW5jbHVkZSIsInJ1bkFmdGVyRmluZFRyaWdnZXIiLCJoYW5kbGVBdXRoQWRhcHRlcnMiLCJlYWNoIiwiY2FsbGJhY2siLCJsaW1pdCIsImZpbmlzaGVkIiwicXVlcnkiLCJyZXN1bHRzIiwiZm9yRWFjaCIsImFzc2lnbiIsIiRndCIsImlzTWFpbnRlbmFuY2UiLCJyYyIsInJlcXVlc3RDb21wbGV4aXR5IiwicXVlcnlEZXB0aCIsIm1heERlcHRoIiwiY2hlY2tEZXB0aCIsIm5vZGUiLCJkZXB0aCIsImlzQXJyYXkiLCJpdGVtIiwiaXNMb2dpY2FsIiwidmFsaWRhdGVRdWVyeUZvcm1hdCIsImdldFVzZXJBbmRSb2xlQUNMIiwidmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uIiwiY2hlY2tTdWJxdWVyeURlcHRoIiwicmVwbGFjZVNlbGVjdCIsInJlcGxhY2VEb250U2VsZWN0IiwicmVwbGFjZUluUXVlcnkiLCJyZXBsYWNlTm90SW5RdWVyeSIsInJlcGxhY2VFcXVhbGl0eSIsImFjbCIsImdldFVzZXJSb2xlcyIsInJvbGVzIiwiZGF0YWJhc2UiLCJuZXdDbGFzc05hbWUiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwibG9hZFNjaGVtYSIsInNjaGVtYUNvbnRyb2xsZXIiLCJoYXNDbGFzcyIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJ0cmFuc2Zvcm1JblF1ZXJ5IiwiaW5RdWVyeU9iamVjdCIsInZhbHVlcyIsInB1c2giLCJzdWJxdWVyeURlcHRoIiwiX3N1YnF1ZXJ5RGVwdGgiLCJtZXNzYWdlIiwid2FybiIsImZpbmRPYmplY3RXaXRoS2V5IiwiaW5RdWVyeVZhbHVlIiwid2hlcmUiLCJhZGRpdGlvbmFsT3B0aW9ucyIsInN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UiLCJyZWFkUHJlZmVyZW5jZSIsInN1YnF1ZXJ5TGltaXQiLCJjaGlsZENvbnRleHQiLCJzdWJxdWVyeSIsInRyYW5zZm9ybU5vdEluUXVlcnkiLCJub3RJblF1ZXJ5T2JqZWN0Iiwibm90SW5RdWVyeVZhbHVlIiwiZ2V0RGVlcGVzdE9iamVjdEZyb21LZXkiLCJqc29uIiwiaWR4Iiwic3JjIiwic3BsaWNlIiwidHJhbnNmb3JtU2VsZWN0Iiwic2VsZWN0T2JqZWN0Iiwib2JqZWN0cyIsInNlbGVjdFZhbHVlIiwidHJhbnNmb3JtRG9udFNlbGVjdCIsImRvbnRTZWxlY3RPYmplY3QiLCJkb250U2VsZWN0VmFsdWUiLCJjbGVhblJlc3VsdEF1dGhEYXRhIiwicGFzc3dvcmQiLCJhdXRoRGF0YSIsInByb3ZpZGVyIiwicmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCIsImNvbnN0cmFpbnQiLCJlcXVhbFRvT2JqZWN0IiwiaGFzRGlyZWN0Q29uc3RyYWludCIsImhhc09wZXJhdG9yQ29uc3RyYWludCIsIm9wdGlvbnMiLCJwcm92aWRlcnMiLCJhdXRoRGF0YU1hbmFnZXIiLCJnZXRQcm92aWRlcnMiLCJvcCIsImV4cGxhaW4iLCJmaWxlc0NvbnRyb2xsZXIiLCJleHBhbmRGaWxlc0luT2JqZWN0IiwiciIsImNvdW50Iiwic2tpcCIsImMiLCJwcm90ZWN0ZWRGaWVsZHMiLCJhZGRQcm90ZWN0ZWRGaWVsZHMiLCJjaGVja1doZXJlIiwid2hlcmVLZXkiLCJyb290RmllbGQiLCJsb2dpY2FsT3BlcmF0b3JFcnJvciIsInN1YlF1ZXJ5Iiwic29ydEtleSIsImdldE9uZVNjaGVtYSIsInNjaGVtYSIsImluY2x1ZGVGaWVsZHMiLCJrZXlGaWVsZHMiLCJ0eXBlIiwiaW5jbHVkZURlcHRoIiwiTWF0aCIsIm1heCIsImluY2x1ZGVDb3VudCIsImluZGV4ZWRSZXN1bHRzIiwiaW5kZXhlZCIsImkiLCJleGVjdXRpb25UcmVlIiwiY3VycmVudCIsImNoaWxkcmVuIiwicmVjdXJzaXZlRXhlY3V0aW9uVHJlZSIsInRyZWVOb2RlIiwicGF0aFJlc3BvbnNlIiwiaW5jbHVkZVBhdGgiLCJuZXdSZXNwb25zZSIsIm5ld09iamVjdCIsImFsbCIsImhhc0FmdGVyRmluZEhvb2siLCJ0cmlnZ2VyRXhpc3RzIiwiYWZ0ZXJGaW5kIiwiYXBwbGljYXRpb25JZCIsInBpcGVsaW5lIiwiZGlzdGluY3QiLCJwYXJzZVF1ZXJ5IiwiUXVlcnkiLCJ3aXRoSlNPTiIsIm1heWJlUnVuQWZ0ZXJGaW5kVHJpZ2dlciIsIm9iamVjdCIsInRvSlNPTiIsInBvaW50ZXJzIiwiZmluZFBvaW50ZXJzIiwicG9pbnRlcnNIYXNoIiwicG9pbnRlciIsImFkZCIsImluY2x1ZGVSZXN0T3B0aW9ucyIsImtleVNldCIsInNldCIsImtleVBhdGgiLCJzaXplIiwiZXhjbHVkZUtleVNldCIsImluY2x1ZGVSZWFkUHJlZmVyZW5jZSIsInF1ZXJ5UHJvbWlzZXMiLCJvYmplY3RJZHMiLCIkaW4iLCJyZXNwb25zZXMiLCJyZXBsYWNlIiwiaW5jbHVkZVJlc3BvbnNlIiwib2JqIiwic2Vzc2lvblRva2VuIiwicmVzcCIsInJlcGxhY2VQb2ludGVycyIsIngiLCJmbGF0Iiwic3Vib2JqZWN0IiwibmV3c3ViIiwiYW5zd2VyIiwicm9vdCIsInN1YmtleSIsIm1vZHVsZSIsImV4cG9ydHMiXSwic291cmNlcyI6WyIuLi9zcmMvUmVzdFF1ZXJ5LmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIEFuIG9iamVjdCB0aGF0IGVuY2Fwc3VsYXRlcyBldmVyeXRoaW5nIHdlIG5lZWQgdG8gcnVuIGEgJ2ZpbmQnXG4vLyBvcGVyYXRpb24sIGVuY29kZWQgaW4gdGhlIFJFU1QgQVBJIGZvcm1hdC5cblxudmFyIFNjaGVtYUNvbnRyb2xsZXIgPSByZXF1aXJlKCcuL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXInKTtcbmNvbnN0IERhdGFiYXNlQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvRGF0YWJhc2VDb250cm9sbGVyJyk7XG52YXIgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJykuUGFyc2U7XG52YXIgbG9nZ2VyID0gcmVxdWlyZSgnLi9sb2dnZXInKS5kZWZhdWx0O1xuY29uc3QgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG5jb25zdCB7IGNvbnRpbnVlV2hpbGUgfSA9IHJlcXVpcmUoJ3BhcnNlL2xpYi9ub2RlL3Byb21pc2VVdGlscycpO1xuY29uc3QgQWx3YXlzU2VsZWN0ZWRLZXlzID0gWydvYmplY3RJZCcsICdjcmVhdGVkQXQnLCAndXBkYXRlZEF0JywgJ0FDTCddO1xuY29uc3QgeyBlbmZvcmNlUm9sZVNlY3VyaXR5IH0gPSByZXF1aXJlKCcuL1NoYXJlZFJlc3QnKTtcbmNvbnN0IHsgY3JlYXRlU2FuaXRpemVkRXJyb3IgfSA9IHJlcXVpcmUoJy4vRXJyb3InKTtcbmNvbnN0IFV0aWxzID0gcmVxdWlyZSgnLi9VdGlscycpO1xuXG4vLyByZXN0T3B0aW9ucyBjYW4gaW5jbHVkZTpcbi8vICAgc2tpcFxuLy8gICBsaW1pdFxuLy8gICBvcmRlclxuLy8gICBjb3VudFxuLy8gICBpbmNsdWRlXG4vLyAgIGtleXNcbi8vICAgZXhjbHVkZUtleXNcbi8vICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXlcbi8vICAgcmVhZFByZWZlcmVuY2Vcbi8vICAgaW5jbHVkZVJlYWRQcmVmZXJlbmNlXG4vLyAgIHN1YnF1ZXJ5UmVhZFByZWZlcmVuY2Vcbi8qKlxuICogVXNlIHRvIHBlcmZvcm0gYSBxdWVyeSBvbiBhIGNsYXNzLiBJdCB3aWxsIHJ1biBzZWN1cml0eSBjaGVja3MgYW5kIHRyaWdnZXJzLlxuICogQHBhcmFtIG9wdGlvbnNcbiAqIEBwYXJhbSBvcHRpb25zLm1ldGhvZCB7UmVzdFF1ZXJ5Lk1ldGhvZH0gVGhlIHR5cGUgb2YgcXVlcnkgdG8gcGVyZm9ybVxuICogQHBhcmFtIG9wdGlvbnMuY29uZmlnIHtQYXJzZVNlcnZlckNvbmZpZ3VyYXRpb259IFRoZSBzZXJ2ZXIgY29uZmlndXJhdGlvblxuICogQHBhcmFtIG9wdGlvbnMuYXV0aCB7QXV0aH0gVGhlIGF1dGggb2JqZWN0IGZvciB0aGUgcmVxdWVzdFxuICogQHBhcmFtIG9wdGlvbnMuY2xhc3NOYW1lIHtzdHJpbmd9IFRoZSBuYW1lIG9mIHRoZSBjbGFzcyB0byBxdWVyeVxuICogQHBhcmFtIG9wdGlvbnMucmVzdFdoZXJlIHtvYmplY3R9IFRoZSB3aGVyZSBvYmplY3QgZm9yIHRoZSBxdWVyeVxuICogQHBhcmFtIG9wdGlvbnMucmVzdE9wdGlvbnMge29iamVjdH0gVGhlIG9wdGlvbnMgb2JqZWN0IGZvciB0aGUgcXVlcnlcbiAqIEBwYXJhbSBvcHRpb25zLnJ1bkFmdGVyRmluZCB7Ym9vbGVhbn0gV2hldGhlciB0byBydW4gdGhlIGFmdGVyRmluZCB0cmlnZ2VyXG4gKiBAcGFyYW0gb3B0aW9ucy5ydW5CZWZvcmVGaW5kIHtib29sZWFufSBXaGV0aGVyIHRvIHJ1biB0aGUgYmVmb3JlRmluZCB0cmlnZ2VyXG4gKiBAcGFyYW0gb3B0aW9ucy5jb250ZXh0IHtvYmplY3R9IFRoZSBjb250ZXh0IG9iamVjdCBmb3IgdGhlIHF1ZXJ5XG4gKiBAcmV0dXJucyB7UHJvbWlzZTxfVW5zYWZlUmVzdFF1ZXJ5Pn0gQSBwcm9taXNlIHRoYXQgaXMgcmVzb2x2ZWQgd2l0aCB0aGUgX1Vuc2FmZVJlc3RRdWVyeSBvYmplY3RcbiAqL1xuYXN5bmMgZnVuY3Rpb24gUmVzdFF1ZXJ5KHtcbiAgbWV0aG9kLFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGNsYXNzTmFtZSxcbiAgcmVzdFdoZXJlID0ge30sXG4gIHJlc3RPcHRpb25zID0ge30sXG4gIHJ1bkFmdGVyRmluZCA9IHRydWUsXG4gIHJ1bkJlZm9yZUZpbmQgPSB0cnVlLFxuICBjb250ZXh0LFxufSkge1xuICBpZiAoIVtSZXN0UXVlcnkuTWV0aG9kLmZpbmQsIFJlc3RRdWVyeS5NZXRob2QuZ2V0XS5pbmNsdWRlcyhtZXRob2QpKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICdiYWQgcXVlcnkgdHlwZScpO1xuICB9XG4gIGNvbnN0IGlzR2V0ID0gbWV0aG9kID09PSBSZXN0UXVlcnkuTWV0aG9kLmdldDtcbiAgZW5mb3JjZVJvbGVTZWN1cml0eShtZXRob2QsIGNsYXNzTmFtZSwgYXV0aCwgY29uZmlnKTtcbiAgY29uc3QgcmVzdWx0ID0gcnVuQmVmb3JlRmluZFxuICAgID8gYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5RdWVyeVRyaWdnZXIoXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVGaW5kLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgcmVzdFdoZXJlLFxuICAgICAgcmVzdE9wdGlvbnMsXG4gICAgICBjb25maWcsXG4gICAgICBhdXRoLFxuICAgICAgY29udGV4dCxcbiAgICAgIGlzR2V0XG4gICAgKVxuICAgIDogUHJvbWlzZS5yZXNvbHZlKHsgcmVzdFdoZXJlLCByZXN0T3B0aW9ucyB9KTtcblxuICByZXR1cm4gbmV3IF9VbnNhZmVSZXN0UXVlcnkoXG4gICAgY29uZmlnLFxuICAgIGF1dGgsXG4gICAgY2xhc3NOYW1lLFxuICAgIHJlc3VsdC5yZXN0V2hlcmUgfHwgcmVzdFdoZXJlLFxuICAgIHJlc3VsdC5yZXN0T3B0aW9ucyB8fCByZXN0T3B0aW9ucyxcbiAgICBydW5BZnRlckZpbmQsXG4gICAgY29udGV4dCxcbiAgICBpc0dldFxuICApO1xufVxuXG5SZXN0UXVlcnkuTWV0aG9kID0gT2JqZWN0LmZyZWV6ZSh7XG4gIGdldDogJ2dldCcsXG4gIGZpbmQ6ICdmaW5kJyxcbn0pO1xuXG4vKipcbiAqIF9VbnNhZmVSZXN0UXVlcnkgaXMgbWVhbnQgZm9yIHNwZWNpZmljIGludGVybmFsIHVzYWdlIG9ubHkuIFdoZW4geW91IG5lZWQgdG8gc2tpcCBzZWN1cml0eSBjaGVja3Mgb3Igc29tZSB0cmlnZ2Vycy5cbiAqIERvbid0IHVzZSBpdCBpZiB5b3UgZG9uJ3Qga25vdyB3aGF0IHlvdSBhcmUgZG9pbmcuXG4gKiBAcGFyYW0gY29uZmlnXG4gKiBAcGFyYW0gYXV0aFxuICogQHBhcmFtIGNsYXNzTmFtZVxuICogQHBhcmFtIHJlc3RXaGVyZVxuICogQHBhcmFtIHJlc3RPcHRpb25zXG4gKiBAcGFyYW0gcnVuQWZ0ZXJGaW5kXG4gKiBAcGFyYW0gY29udGV4dFxuICovXG5mdW5jdGlvbiBfVW5zYWZlUmVzdFF1ZXJ5KFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGNsYXNzTmFtZSxcbiAgcmVzdFdoZXJlID0ge30sXG4gIHJlc3RPcHRpb25zID0ge30sXG4gIHJ1bkFmdGVyRmluZCA9IHRydWUsXG4gIGNvbnRleHQsXG4gIGlzR2V0XG4pIHtcbiAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gIHRoaXMuYXV0aCA9IGF1dGg7XG4gIHRoaXMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB0aGlzLnJlc3RXaGVyZSA9IHJlc3RXaGVyZTtcbiAgdGhpcy5yZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zO1xuICB0aGlzLnJ1bkFmdGVyRmluZCA9IHJ1bkFmdGVyRmluZDtcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG4gIHRoaXMuZmluZE9wdGlvbnMgPSB7fTtcbiAgdGhpcy5jb250ZXh0ID0gY29udGV4dCB8fCB7fTtcbiAgdGhpcy5pc0dldCA9IGlzR2V0O1xuICBpZiAoIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PSAnX1Nlc3Npb24nKSB7XG4gICAgICBpZiAoIXRoaXMuYXV0aC51c2VyKSB7XG4gICAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTiwgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbicsIGNvbmZpZyk7XG4gICAgICB9XG4gICAgICB0aGlzLnJlc3RXaGVyZSA9IHtcbiAgICAgICAgJGFuZDogW1xuICAgICAgICAgIHRoaXMucmVzdFdoZXJlLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHVzZXI6IHtcbiAgICAgICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgICAgICAgb2JqZWN0SWQ6IHRoaXMuYXV0aC51c2VyLmlkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBSZWplY3QgcHJvaGliaXRlZCBrZXl3b3JkcyBpbiBmaWVsZCBwYXRoc1xuICBmb3IgKGNvbnN0IG9wdGlvbiBvZiBbJ2tleXMnLCAnZXhjbHVkZUtleXMnLCAnaW5jbHVkZSddKSB7XG4gICAgaWYgKHR5cGVvZiByZXN0T3B0aW9uc1tvcHRpb25dICE9PSAnc3RyaW5nJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIEZpZWxkIG5hbWVzIGhhdmUgbm8gdmFsdWUsIHNvIG9ubHkga2V5IGVudHJpZXMgb2YgdGhlIGRlbnlsaXN0IG1hdGNoXG4gICAgY29uc3QgZmllbGRzID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgcmVzdE9wdGlvbnNbb3B0aW9uXS5zcGxpdCgvWywuXS8pLm1hcChuYW1lID0+IFtuYW1lLCB1bmRlZmluZWRdKVxuICAgICk7XG4gICAgdHJ5IHtcbiAgICAgIFV0aWxzLmNoZWNrUHJvaGliaXRlZEtleXdvcmRzKGNvbmZpZywgZmllbGRzKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsIGAke2Vycm9yfWApO1xuICAgIH1cbiAgfVxuXG4gIHRoaXMuZG9Db3VudCA9IGZhbHNlO1xuICB0aGlzLmluY2x1ZGVBbGwgPSBmYWxzZTtcblxuICAvLyBUaGUgZm9ybWF0IGZvciB0aGlzLmluY2x1ZGUgaXMgbm90IHRoZSBzYW1lIGFzIHRoZSBmb3JtYXQgZm9yIHRoZVxuICAvLyBpbmNsdWRlIG9wdGlvbiAtIGl0J3MgdGhlIHBhdGhzIHdlIHNob3VsZCBpbmNsdWRlLCBpbiBvcmRlcixcbiAgLy8gc3RvcmVkIGFzIGFycmF5cywgdGFraW5nIGludG8gYWNjb3VudCB0aGF0IHdlIG5lZWQgdG8gaW5jbHVkZSBmb29cbiAgLy8gYmVmb3JlIGluY2x1ZGluZyBmb28uYmFyLiBBbHNvIGl0IHNob3VsZCBkZWR1cGUuXG4gIC8vIEZvciBleGFtcGxlLCBwYXNzaW5nIGFuIGFyZyBvZiBpbmNsdWRlPWZvby5iYXIsZm9vLmJheiBjb3VsZCBsZWFkIHRvXG4gIC8vIHRoaXMuaW5jbHVkZSA9IFtbJ2ZvbyddLCBbJ2ZvbycsICdiYXonXSwgWydmb28nLCAnYmFyJ11dXG4gIHRoaXMuaW5jbHVkZSA9IFtdO1xuICBsZXQga2V5c0ZvckluY2x1ZGUgPSAnJztcblxuICAvLyBJZiB3ZSBoYXZlIGtleXMsIHdlIHByb2JhYmx5IHdhbnQgdG8gZm9yY2Ugc29tZSBpbmNsdWRlcyAobi0xIGxldmVsKVxuICAvLyBTZWUgaXNzdWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL2lzc3Vlcy8zMTg1XG4gIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVzdE9wdGlvbnMsICdrZXlzJykpIHtcbiAgICBrZXlzRm9ySW5jbHVkZSA9IHJlc3RPcHRpb25zLmtleXM7XG4gIH1cblxuICAvLyBJZiB3ZSBoYXZlIGtleXMsIHdlIHByb2JhYmx5IHdhbnQgdG8gZm9yY2Ugc29tZSBpbmNsdWRlcyAobi0xIGxldmVsKVxuICAvLyBpbiBvcmRlciB0byBleGNsdWRlIHNwZWNpZmljIGtleXMuXG4gIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVzdE9wdGlvbnMsICdleGNsdWRlS2V5cycpKSB7XG4gICAga2V5c0ZvckluY2x1ZGUgKz0gJywnICsgcmVzdE9wdGlvbnMuZXhjbHVkZUtleXM7XG4gIH1cblxuICBpZiAoa2V5c0ZvckluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgIGtleXNGb3JJbmNsdWRlID0ga2V5c0ZvckluY2x1ZGVcbiAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAuZmlsdGVyKGtleSA9PiB7XG4gICAgICAgIC8vIEF0IGxlYXN0IDIgY29tcG9uZW50c1xuICAgICAgICByZXR1cm4ga2V5LnNwbGl0KCcuJykubGVuZ3RoID4gMTtcbiAgICAgIH0pXG4gICAgICAubWFwKGtleSA9PiB7XG4gICAgICAgIC8vIFNsaWNlIHRoZSBsYXN0IGNvbXBvbmVudCAoYS5iLmMgLT4gYS5iKVxuICAgICAgICAvLyBPdGhlcndpc2Ugd2UnbGwgaW5jbHVkZSBvbmUgbGV2ZWwgdG9vIG11Y2guXG4gICAgICAgIHJldHVybiBrZXkuc2xpY2UoMCwga2V5Lmxhc3RJbmRleE9mKCcuJykpO1xuICAgICAgfSlcbiAgICAgIC5qb2luKCcsJyk7XG5cbiAgICAvLyBDb25jYXQgdGhlIHBvc3NpYmx5IHByZXNlbnQgaW5jbHVkZSBzdHJpbmcgd2l0aCB0aGUgb25lIGZyb20gdGhlIGtleXNcbiAgICAvLyBEZWR1cCAvIHNvcnRpbmcgaXMgaGFuZGxlIGluICdpbmNsdWRlJyBjYXNlLlxuICAgIGlmIChrZXlzRm9ySW5jbHVkZS5sZW5ndGggPiAwKSB7XG4gICAgICBpZiAoIXJlc3RPcHRpb25zLmluY2x1ZGUgfHwgcmVzdE9wdGlvbnMuaW5jbHVkZS5sZW5ndGggPT0gMCkge1xuICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlID0ga2V5c0ZvckluY2x1ZGU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlICs9ICcsJyArIGtleXNGb3JJbmNsdWRlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZvciAodmFyIG9wdGlvbiBpbiByZXN0T3B0aW9ucykge1xuICAgIHN3aXRjaCAob3B0aW9uKSB7XG4gICAgICBjYXNlICdrZXlzJzoge1xuICAgICAgICBjb25zdCBrZXlzID0gcmVzdE9wdGlvbnMua2V5c1xuICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgLmZpbHRlcihrZXkgPT4ga2V5Lmxlbmd0aCA+IDApXG4gICAgICAgICAgLmNvbmNhdChBbHdheXNTZWxlY3RlZEtleXMpO1xuICAgICAgICB0aGlzLmtleXMgPSBBcnJheS5mcm9tKG5ldyBTZXQoa2V5cykpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJ2V4Y2x1ZGVLZXlzJzoge1xuICAgICAgICBjb25zdCBleGNsdWRlID0gcmVzdE9wdGlvbnMuZXhjbHVkZUtleXNcbiAgICAgICAgICAuc3BsaXQoJywnKVxuICAgICAgICAgIC5maWx0ZXIoayA9PiBBbHdheXNTZWxlY3RlZEtleXMuaW5kZXhPZihrKSA8IDApO1xuICAgICAgICB0aGlzLmV4Y2x1ZGVLZXlzID0gQXJyYXkuZnJvbShuZXcgU2V0KGV4Y2x1ZGUpKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdjb3VudCc6XG4gICAgICAgIHRoaXMuZG9Db3VudCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZUFsbCc6XG4gICAgICAgIHRoaXMuaW5jbHVkZUFsbCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnZXhwbGFpbic6XG4gICAgICBjYXNlICdoaW50JzpcbiAgICAgIGNhc2UgJ2Rpc3RpbmN0JzpcbiAgICAgIGNhc2UgJ3BpcGVsaW5lJzpcbiAgICAgIGNhc2UgJ3NraXAnOlxuICAgICAgY2FzZSAnbGltaXQnOlxuICAgICAgY2FzZSAncmVhZFByZWZlcmVuY2UnOlxuICAgICAgY2FzZSAnY29tbWVudCc6XG4gICAgICBjYXNlICdyYXdWYWx1ZXMnOlxuICAgICAgY2FzZSAncmF3RmllbGROYW1lcyc6XG4gICAgICAgIHRoaXMuZmluZE9wdGlvbnNbb3B0aW9uXSA9IHJlc3RPcHRpb25zW29wdGlvbl07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnb3JkZXInOlxuICAgICAgICB2YXIgZmllbGRzID0gcmVzdE9wdGlvbnMub3JkZXIuc3BsaXQoJywnKTtcbiAgICAgICAgdGhpcy5maW5kT3B0aW9ucy5zb3J0ID0gZmllbGRzLnJlZHVjZSgoc29ydE1hcCwgZmllbGQpID0+IHtcbiAgICAgICAgICBmaWVsZCA9IGZpZWxkLnRyaW0oKTtcbiAgICAgICAgICBpZiAoZmllbGQgPT09ICckc2NvcmUnIHx8IGZpZWxkID09PSAnLSRzY29yZScpIHtcbiAgICAgICAgICAgIHNvcnRNYXAuc2NvcmUgPSB7ICRtZXRhOiAndGV4dFNjb3JlJyB9O1xuICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRbMF0gPT0gJy0nKSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkLnNsaWNlKDEpXSA9IC0xO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkXSA9IDE7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBzb3J0TWFwO1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZSc6IHtcbiAgICAgICAgY29uc3QgcGF0aHMgPSByZXN0T3B0aW9ucy5pbmNsdWRlLnNwbGl0KCcsJyk7XG4gICAgICAgIGlmIChwYXRocy5pbmNsdWRlcygnKicpKSB7XG4gICAgICAgICAgdGhpcy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICAvLyBMb2FkIHRoZSBleGlzdGluZyBpbmNsdWRlcyAoZnJvbSBrZXlzKVxuICAgICAgICBjb25zdCBwYXRoU2V0ID0gcGF0aHMucmVkdWNlKChtZW1vLCBwYXRoKSA9PiB7XG4gICAgICAgICAgLy8gU3BsaXQgZWFjaCBwYXRocyBvbiAuIChhLmIuYyAtPiBbYSxiLGNdKVxuICAgICAgICAgIC8vIHJlZHVjZSB0byBjcmVhdGUgYWxsIHBhdGhzXG4gICAgICAgICAgLy8gKFthLGIsY10gLT4ge2E6IHRydWUsICdhLmInOiB0cnVlLCAnYS5iLmMnOiB0cnVlfSlcbiAgICAgICAgICByZXR1cm4gcGF0aC5zcGxpdCgnLicpLnJlZHVjZSgobWVtbywgcGF0aCwgaW5kZXgsIHBhcnRzKSA9PiB7XG4gICAgICAgICAgICBtZW1vW3BhcnRzLnNsaWNlKDAsIGluZGV4ICsgMSkuam9pbignLicpXSA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgICAgICB9LCBtZW1vKTtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIHRoaXMuaW5jbHVkZSA9IE9iamVjdC5rZXlzKHBhdGhTZXQpXG4gICAgICAgICAgLm1hcChzID0+IHtcbiAgICAgICAgICAgIHJldHVybiBzLnNwbGl0KCcuJyk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuc29ydCgoYSwgYikgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIGEubGVuZ3RoIC0gYi5sZW5ndGg7IC8vIFNvcnQgYnkgbnVtYmVyIG9mIGNvbXBvbmVudHNcbiAgICAgICAgICB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdyZWRpcmVjdENsYXNzTmFtZUZvcktleSc6XG4gICAgICAgIHRoaXMucmVkaXJlY3RLZXkgPSByZXN0T3B0aW9ucy5yZWRpcmVjdENsYXNzTmFtZUZvcktleTtcbiAgICAgICAgdGhpcy5yZWRpcmVjdENsYXNzTmFtZSA9IG51bGw7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZVJlYWRQcmVmZXJlbmNlJzpcbiAgICAgIGNhc2UgJ3N1YnF1ZXJ5UmVhZFByZWZlcmVuY2UnOlxuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdiYWQgb3B0aW9uOiAnICsgb3B0aW9uKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gQSBjb252ZW5pZW50IG1ldGhvZCB0byBwZXJmb3JtIGFsbCB0aGUgc3RlcHMgb2YgcHJvY2Vzc2luZyBhIHF1ZXJ5XG4vLyBpbiBvcmRlci5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB0aGUgcmVzcG9uc2UgLSBhbiBvYmplY3Qgd2l0aCBvcHRpb25hbCBrZXlzXG4vLyAncmVzdWx0cycgYW5kICdjb3VudCcuXG4vLyBUT0RPOiBjb25zb2xpZGF0ZSB0aGUgcmVwbGFjZVggZnVuY3Rpb25zXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24gKGV4ZWN1dGVPcHRpb25zKSB7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlUXVlcnlEZXB0aCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuYnVpbGRSZXN0V2hlcmUoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlbnlQcm90ZWN0ZWRGaWVsZHMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGVBbGwoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlSW5jbHVkZUNvbXBsZXhpdHkoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUV4Y2x1ZGVLZXlzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5GaW5kKGV4ZWN1dGVPcHRpb25zKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkNvdW50KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVJbmNsdWRlKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5BZnRlckZpbmRUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoQWRhcHRlcnMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlc3BvbnNlO1xuICAgIH0pO1xufTtcblxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUuZWFjaCA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICBjb25zdCB7IGNvbmZpZywgYXV0aCwgY2xhc3NOYW1lLCByZXN0V2hlcmUsIHJlc3RPcHRpb25zIH0gPSB0aGlzO1xuICAvLyBpZiB0aGUgbGltaXQgaXMgc2V0LCB1c2UgaXRcbiAgcmVzdE9wdGlvbnMubGltaXQgPSByZXN0T3B0aW9ucy5saW1pdCB8fCAxMDA7XG4gIHJlc3RPcHRpb25zLm9yZGVyID0gJ29iamVjdElkJztcbiAgbGV0IGZpbmlzaGVkID0gZmFsc2U7XG5cbiAgcmV0dXJuIGNvbnRpbnVlV2hpbGUoXG4gICAgKCkgPT4ge1xuICAgICAgcmV0dXJuICFmaW5pc2hlZDtcbiAgICB9LFxuICAgIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIFNhZmUgaGVyZSB0byB1c2UgX1Vuc2FmZVJlc3RRdWVyeSBiZWNhdXNlIHRoZSBzZWN1cml0eSB3YXMgYWxyZWFkeVxuICAgICAgLy8gY2hlY2tlZCBkdXJpbmcgXCJhd2FpdCBSZXN0UXVlcnkoKVwiXG4gICAgICBjb25zdCBxdWVyeSA9IG5ldyBfVW5zYWZlUmVzdFF1ZXJ5KFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgcmVzdFdoZXJlLFxuICAgICAgICByZXN0T3B0aW9ucyxcbiAgICAgICAgdGhpcy5ydW5BZnRlckZpbmQsXG4gICAgICAgIHRoaXMuY29udGV4dFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHsgcmVzdWx0cyB9ID0gYXdhaXQgcXVlcnkuZXhlY3V0ZSgpO1xuICAgICAgcmVzdWx0cy5mb3JFYWNoKGNhbGxiYWNrKTtcbiAgICAgIGZpbmlzaGVkID0gcmVzdWx0cy5sZW5ndGggPCByZXN0T3B0aW9ucy5saW1pdDtcbiAgICAgIGlmICghZmluaXNoZWQpIHtcbiAgICAgICAgcmVzdFdoZXJlLm9iamVjdElkID0gT2JqZWN0LmFzc2lnbih7fSwgcmVzdFdoZXJlLm9iamVjdElkLCB7XG4gICAgICAgICAgJGd0OiByZXN1bHRzW3Jlc3VsdHMubGVuZ3RoIC0gMV0ub2JqZWN0SWQsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgKTtcbn07XG5cbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnZhbGlkYXRlUXVlcnlEZXB0aCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCByYyA9IHRoaXMuY29uZmlnLnJlcXVlc3RDb21wbGV4aXR5O1xuICBpZiAoIXJjIHx8IHJjLnF1ZXJ5RGVwdGggPT09IC0xKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IG1heERlcHRoID0gcmMucXVlcnlEZXB0aDtcbiAgY29uc3QgY2hlY2tEZXB0aCA9IChub2RlLCBkZXB0aCkgPT4ge1xuICAgIGlmIChkZXB0aCA+IG1heERlcHRoKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgIGBRdWVyeSBjb25kaXRpb24gbmVzdGluZyBkZXB0aCBleGNlZWRzIG1heGltdW0gYWxsb3dlZCBkZXB0aCBvZiAke21heERlcHRofWBcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChub2RlID09PSBudWxsIHx8IHR5cGVvZiBub2RlICE9PSAnb2JqZWN0Jykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheShub2RlKSkge1xuICAgICAgZm9yIChjb25zdCBpdGVtIG9mIG5vZGUpIHtcbiAgICAgICAgY2hlY2tEZXB0aChpdGVtLCBkZXB0aCk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIERlc2NlbmQgaW50byBldmVyeSB2YWx1ZSBzbyB0aGF0IGxvZ2ljYWwgb3BlcmF0b3JzICgkb3IvJGFuZC8kbm9yKSBuZXN0ZWRcbiAgICAvLyB1bmRlciBmaWVsZC1sZXZlbCBvcGVyYXRvcnMgKGUuZy4gJGVsZW1NYXRjaCwgJG5vdCkgb3IgcGxhaW4gZmllbGQgbmFtZXMgYXJlXG4gICAgLy8gc3RpbGwgY291bnRlZC4gT25seSBsb2dpY2FsIG9wZXJhdG9ycyBpbmNyZWFzZSB0aGUgZGVwdGgsIHdoaWNoIHByZXNlcnZlcyB0aGVcbiAgICAvLyBkb2N1bWVudGVkIG1lYW5pbmcgb2YgYHF1ZXJ5RGVwdGhgLlxuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKG5vZGUpKSB7XG4gICAgICBjb25zdCBpc0xvZ2ljYWwgPSBrZXkgPT09ICckb3InIHx8IGtleSA9PT0gJyRhbmQnIHx8IGtleSA9PT0gJyRub3InO1xuICAgICAgY2hlY2tEZXB0aChub2RlW2tleV0sIGlzTG9naWNhbCA/IGRlcHRoICsgMSA6IGRlcHRoKTtcbiAgICB9XG4gIH07XG4gIGNoZWNrRGVwdGgodGhpcy5yZXN0V2hlcmUsIDApO1xufTtcblxuLy8gVmFsaWRhdGVzIHRoZSBmb3JtYXQgb2YgdGhlIHdoZXJlIGNsYXVzZSBiZWZvcmUgaXQgaXMgcHJvY2Vzc2VkXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS52YWxpZGF0ZVF1ZXJ5Rm9ybWF0ID0gZnVuY3Rpb24gKCkge1xuICBEYXRhYmFzZUNvbnRyb2xsZXIudmFsaWRhdGVRdWVyeUZvcm1hdCh0aGlzLnJlc3RXaGVyZSk7XG59O1xuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5idWlsZFJlc3RXaGVyZSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVRdWVyeUZvcm1hdCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZ2V0VXNlckFuZFJvbGVBQ0woKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNoZWNrU3VicXVlcnlEZXB0aCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVwbGFjZVNlbGVjdCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVwbGFjZURvbnRTZWxlY3QoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlcGxhY2VJblF1ZXJ5KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXBsYWNlTm90SW5RdWVyeSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVwbGFjZUVxdWFsaXR5KCk7XG4gICAgfSk7XG59O1xuXG4vLyBVc2VzIHRoZSBBdXRoIG9iamVjdCB0byBnZXQgdGhlIGxpc3Qgb2Ygcm9sZXMsIGFkZHMgdGhlIHVzZXIgaWRcbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLmdldFVzZXJBbmRSb2xlQUNMID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgdGhpcy5maW5kT3B0aW9ucy5hY2wgPSBbJyonXTtcblxuICBpZiAodGhpcy5hdXRoLnVzZXIpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLmdldFVzZXJSb2xlcygpLnRoZW4ocm9sZXMgPT4ge1xuICAgICAgdGhpcy5maW5kT3B0aW9ucy5hY2wgPSB0aGlzLmZpbmRPcHRpb25zLmFjbC5jb25jYXQocm9sZXMsIFt0aGlzLmF1dGgudXNlci5pZF0pO1xuICAgICAgcmV0dXJuO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gQ2hhbmdlcyB0aGUgY2xhc3NOYW1lIGlmIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IGlzIHNldC5cbi8vIFJldHVybnMgYSBwcm9taXNlLlxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUucmVkaXJlY3RDbGFzc05hbWVGb3JLZXkgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5yZWRpcmVjdEtleSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIC8vIFdlIG5lZWQgdG8gY2hhbmdlIHRoZSBjbGFzcyBuYW1lIGJhc2VkIG9uIHRoZSBzY2hlbWFcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5KHRoaXMuY2xhc3NOYW1lLCB0aGlzLnJlZGlyZWN0S2V5KVxuICAgIC50aGVuKG5ld0NsYXNzTmFtZSA9PiB7XG4gICAgICB0aGlzLmNsYXNzTmFtZSA9IG5ld0NsYXNzTmFtZTtcbiAgICAgIHRoaXMucmVkaXJlY3RDbGFzc05hbWUgPSBuZXdDbGFzc05hbWU7XG5cbiAgICAgIC8vIFJlLWFwcGx5IHNlY3VyaXR5IGNoZWNrcyBmb3IgdGhlIHJlZGlyZWN0ZWQgY2xhc3MgbmFtZSwgc2luY2UgdGhlXG4gICAgICAvLyBjaGVja3MgaW4gdGhlIGNvbnN0cnVjdG9yIGFuZCBpbiByZXN0LmZpbmQgcmFuIGFnYWluc3QgdGhlIG9yaWdpbmFsXG4gICAgICAvLyBjbGFzcyBuYW1lIGJlZm9yZSB0aGUgcmVkaXJlY3QuXG4gICAgICBpZiAoIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgICAgICBlbmZvcmNlUm9sZVNlY3VyaXR5KCdmaW5kJywgdGhpcy5jbGFzc05hbWUsIHRoaXMuYXV0aCwgdGhpcy5jb25maWcpO1xuXG4gICAgICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19TZXNzaW9uJykge1xuICAgICAgICAgIGlmICghdGhpcy5hdXRoLnVzZXIpIHtcbiAgICAgICAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sXG4gICAgICAgICAgICAgICdJbnZhbGlkIHNlc3Npb24gdG9rZW4nLFxuICAgICAgICAgICAgICB0aGlzLmNvbmZpZ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5yZXN0V2hlcmUgPSB7XG4gICAgICAgICAgICAkYW5kOiBbXG4gICAgICAgICAgICAgIHRoaXMucmVzdFdoZXJlLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgdXNlcjoge1xuICAgICAgICAgICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgICAgICAgICAgICBvYmplY3RJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pO1xufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIGFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiBjb25maWcuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmIChcbiAgICB0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmXG4gICAgIXRoaXMuYXV0aC5pc01hc3RlciAmJlxuICAgIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTFcbiAgKSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICAnVGhpcyB1c2VyIGlzIG5vdCBhbGxvd2VkIHRvIGFjY2VzcyAnICsgJ25vbi1leGlzdGVudCBjbGFzczogJyArIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgICAgdGhpcy5jb25maWdcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIHRyYW5zZm9ybUluUXVlcnkoaW5RdWVyeU9iamVjdCwgY2xhc3NOYW1lLCByZXN1bHRzKSB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICB2YWx1ZXMucHVzaCh7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogY2xhc3NOYW1lLFxuICAgICAgb2JqZWN0SWQ6IHJlc3VsdC5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBkZWxldGUgaW5RdWVyeU9iamVjdFsnJGluUXVlcnknXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkoaW5RdWVyeU9iamVjdFsnJGluJ10pKSB7XG4gICAgaW5RdWVyeU9iamVjdFsnJGluJ10gPSBpblF1ZXJ5T2JqZWN0WyckaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBpblF1ZXJ5T2JqZWN0WyckaW4nXSA9IHZhbHVlcztcbiAgfVxufVxuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5jaGVja1N1YnF1ZXJ5RGVwdGggPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIgfHwgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcmMgPSB0aGlzLmNvbmZpZy5yZXF1ZXN0Q29tcGxleGl0eTtcbiAgaWYgKCFyYyB8fCByYy5zdWJxdWVyeURlcHRoID09PSAtMSkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBkZXB0aCA9IHRoaXMuY29udGV4dC5fc3VicXVlcnlEZXB0aCB8fCAwO1xuICBpZiAoZGVwdGggPiByYy5zdWJxdWVyeURlcHRoKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGBTdWJxdWVyeSBuZXN0aW5nIGRlcHRoIGV4Y2VlZHMgbWF4aW11bSBhbGxvd2VkIGRlcHRoIG9mICR7cmMuc3VicXVlcnlEZXB0aH1gO1xuICAgIGxvZ2dlci53YXJuKG1lc3NhZ2UpO1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCBtZXNzYWdlKTtcbiAgfVxufTtcblxuLy8gUmVwbGFjZXMgYSAkaW5RdWVyeSBjbGF1c2UgYnkgcnVubmluZyB0aGUgc3VicXVlcnksIGlmIHRoZXJlIGlzIGFuXG4vLyAkaW5RdWVyeSBjbGF1c2UuXG4vLyBUaGUgJGluUXVlcnkgY2xhdXNlIHR1cm5zIGludG8gYW4gJGluIHdpdGggdmFsdWVzIHRoYXQgYXJlIGp1c3Rcbi8vIHBvaW50ZXJzIHRvIHRoZSBvYmplY3RzIHJldHVybmVkIGluIHRoZSBzdWJxdWVyeS5cbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VJblF1ZXJ5ID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICB2YXIgaW5RdWVyeU9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJGluUXVlcnknKTtcbiAgaWYgKCFpblF1ZXJ5T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIGluUXVlcnkgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHdoZXJlIGFuZCBjbGFzc05hbWVcbiAgdmFyIGluUXVlcnlWYWx1ZSA9IGluUXVlcnlPYmplY3RbJyRpblF1ZXJ5J107XG4gIGlmICghaW5RdWVyeVZhbHVlLndoZXJlIHx8ICFpblF1ZXJ5VmFsdWUuY2xhc3NOYW1lKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICdpbXByb3BlciB1c2FnZSBvZiAkaW5RdWVyeScpO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IGluUXVlcnlWYWx1ZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmICh0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgY29uc3QgcmMgPSB0aGlzLmNvbmZpZy5yZXF1ZXN0Q29tcGxleGl0eTtcbiAgICBpZiAocmMgJiYgcmMuc3VicXVlcnlMaW1pdCA+IDApIHtcbiAgICAgIGFkZGl0aW9uYWxPcHRpb25zLmxpbWl0ID0gcmMuc3VicXVlcnlMaW1pdDtcbiAgICB9XG4gIH1cblxuICBjb25zdCBjaGlsZENvbnRleHQgPSB7IC4uLnRoaXMuY29udGV4dCwgX3N1YnF1ZXJ5RGVwdGg6ICh0aGlzLmNvbnRleHQuX3N1YnF1ZXJ5RGVwdGggfHwgMCkgKyAxIH07XG4gIGNvbnN0IHN1YnF1ZXJ5ID0gYXdhaXQgUmVzdFF1ZXJ5KHtcbiAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZmluZCxcbiAgICBjb25maWc6IHRoaXMuY29uZmlnLFxuICAgIGF1dGg6IHRoaXMuYXV0aCxcbiAgICBjbGFzc05hbWU6IGluUXVlcnlWYWx1ZS5jbGFzc05hbWUsXG4gICAgcmVzdFdoZXJlOiBpblF1ZXJ5VmFsdWUud2hlcmUsXG4gICAgcmVzdE9wdGlvbnM6IGFkZGl0aW9uYWxPcHRpb25zLFxuICAgIGNvbnRleHQ6IGNoaWxkQ29udGV4dCxcbiAgfSk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtSW5RdWVyeShpblF1ZXJ5T2JqZWN0LCBzdWJxdWVyeS5jbGFzc05hbWUsIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIFJlY3Vyc2UgdG8gcmVwZWF0XG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZUluUXVlcnkoKTtcbiAgfSk7XG59O1xuXG5mdW5jdGlvbiB0cmFuc2Zvcm1Ob3RJblF1ZXJ5KG5vdEluUXVlcnlPYmplY3QsIGNsYXNzTmFtZSwgcmVzdWx0cykge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiByZXN1bHRzKSB7XG4gICAgdmFsdWVzLnB1c2goe1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6IGNsYXNzTmFtZSxcbiAgICAgIG9iamVjdElkOiByZXN1bHQub2JqZWN0SWQsXG4gICAgfSk7XG4gIH1cbiAgZGVsZXRlIG5vdEluUXVlcnlPYmplY3RbJyRub3RJblF1ZXJ5J107XG4gIGlmIChBcnJheS5pc0FycmF5KG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXSkpIHtcbiAgICBub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10gPSBub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgbm90SW5RdWVyeU9iamVjdFsnJG5pbiddID0gdmFsdWVzO1xuICB9XG59XG5cbi8vIFJlcGxhY2VzIGEgJG5vdEluUXVlcnkgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhblxuLy8gJG5vdEluUXVlcnkgY2xhdXNlLlxuLy8gVGhlICRub3RJblF1ZXJ5IGNsYXVzZSB0dXJucyBpbnRvIGEgJG5pbiB3aXRoIHZhbHVlcyB0aGF0IGFyZSBqdXN0XG4vLyBwb2ludGVycyB0byB0aGUgb2JqZWN0cyByZXR1cm5lZCBpbiB0aGUgc3VicXVlcnkuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlTm90SW5RdWVyeSA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5vdEluUXVlcnlPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRub3RJblF1ZXJ5Jyk7XG4gIGlmICghbm90SW5RdWVyeU9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBub3RJblF1ZXJ5IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSB3aGVyZSBhbmQgY2xhc3NOYW1lXG4gIHZhciBub3RJblF1ZXJ5VmFsdWUgPSBub3RJblF1ZXJ5T2JqZWN0Wyckbm90SW5RdWVyeSddO1xuICBpZiAoIW5vdEluUXVlcnlWYWx1ZS53aGVyZSB8fCAhbm90SW5RdWVyeVZhbHVlLmNsYXNzTmFtZSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCAnaW1wcm9wZXIgdXNhZ2Ugb2YgJG5vdEluUXVlcnknKTtcbiAgfVxuXG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBub3RJblF1ZXJ5VmFsdWUucmVkaXJlY3RDbGFzc05hbWVGb3JLZXksXG4gIH07XG5cbiAgaWYgKHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAodGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIGNvbnN0IHJjID0gdGhpcy5jb25maWcucmVxdWVzdENvbXBsZXhpdHk7XG4gICAgaWYgKHJjICYmIHJjLnN1YnF1ZXJ5TGltaXQgPiAwKSB7XG4gICAgICBhZGRpdGlvbmFsT3B0aW9ucy5saW1pdCA9IHJjLnN1YnF1ZXJ5TGltaXQ7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgY2hpbGRDb250ZXh0ID0geyAuLi50aGlzLmNvbnRleHQsIF9zdWJxdWVyeURlcHRoOiAodGhpcy5jb250ZXh0Ll9zdWJxdWVyeURlcHRoIHx8IDApICsgMSB9O1xuICBjb25zdCBzdWJxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgbWV0aG9kOiBSZXN0UXVlcnkuTWV0aG9kLmZpbmQsXG4gICAgY29uZmlnOiB0aGlzLmNvbmZpZyxcbiAgICBhdXRoOiB0aGlzLmF1dGgsXG4gICAgY2xhc3NOYW1lOiBub3RJblF1ZXJ5VmFsdWUuY2xhc3NOYW1lLFxuICAgIHJlc3RXaGVyZTogbm90SW5RdWVyeVZhbHVlLndoZXJlLFxuICAgIHJlc3RPcHRpb25zOiBhZGRpdGlvbmFsT3B0aW9ucyxcbiAgICBjb250ZXh0OiBjaGlsZENvbnRleHQsXG4gIH0pO1xuXG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtTm90SW5RdWVyeShub3RJblF1ZXJ5T2JqZWN0LCBzdWJxdWVyeS5jbGFzc05hbWUsIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIFJlY3Vyc2UgdG8gcmVwZWF0XG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZU5vdEluUXVlcnkoKTtcbiAgfSk7XG59O1xuXG4vLyBVc2VkIHRvIGdldCB0aGUgZGVlcGVzdCBvYmplY3QgZnJvbSBqc29uIHVzaW5nIGRvdCBub3RhdGlvbi5cbmNvbnN0IGdldERlZXBlc3RPYmplY3RGcm9tS2V5ID0gKGpzb24sIGtleSwgaWR4LCBzcmMpID0+IHtcbiAgaWYgKGtleSBpbiBqc29uKSB7XG4gICAgcmV0dXJuIGpzb25ba2V5XTtcbiAgfVxuICBzcmMuc3BsaWNlKDEpOyAvLyBFeGl0IEVhcmx5XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1TZWxlY3QgPSAoc2VsZWN0T2JqZWN0LCBrZXksIG9iamVjdHMpID0+IHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2Ygb2JqZWN0cykge1xuICAgIHZhbHVlcy5wdXNoKGtleS5zcGxpdCgnLicpLnJlZHVjZShnZXREZWVwZXN0T2JqZWN0RnJvbUtleSwgcmVzdWx0KSk7XG4gIH1cbiAgZGVsZXRlIHNlbGVjdE9iamVjdFsnJHNlbGVjdCddO1xuICBpZiAoQXJyYXkuaXNBcnJheShzZWxlY3RPYmplY3RbJyRpbiddKSkge1xuICAgIHNlbGVjdE9iamVjdFsnJGluJ10gPSBzZWxlY3RPYmplY3RbJyRpbiddLmNvbmNhdCh2YWx1ZXMpO1xuICB9IGVsc2Uge1xuICAgIHNlbGVjdE9iamVjdFsnJGluJ10gPSB2YWx1ZXM7XG4gIH1cbn07XG5cbi8vIFJlcGxhY2VzIGEgJHNlbGVjdCBjbGF1c2UgYnkgcnVubmluZyB0aGUgc3VicXVlcnksIGlmIHRoZXJlIGlzIGFcbi8vICRzZWxlY3QgY2xhdXNlLlxuLy8gVGhlICRzZWxlY3QgY2xhdXNlIHR1cm5zIGludG8gYW4gJGluIHdpdGggdmFsdWVzIHNlbGVjdGVkIG91dCBvZlxuLy8gdGhlIHN1YnF1ZXJ5LlxuLy8gUmV0dXJucyBhIHBvc3NpYmxlLXByb21pc2UuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlU2VsZWN0ID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZWN0T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckc2VsZWN0Jyk7XG4gIGlmICghc2VsZWN0T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIHNlbGVjdCB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gcXVlcnkgYW5kIGtleVxuICB2YXIgc2VsZWN0VmFsdWUgPSBzZWxlY3RPYmplY3RbJyRzZWxlY3QnXTtcbiAgLy8gaU9TIFNESyBkb24ndCBzZW5kIHdoZXJlIGlmIG5vdCBzZXQsIGxldCBpdCBwYXNzXG4gIGlmIChcbiAgICAhc2VsZWN0VmFsdWUucXVlcnkgfHxcbiAgICAhc2VsZWN0VmFsdWUua2V5IHx8XG4gICAgdHlwZW9mIHNlbGVjdFZhbHVlLnF1ZXJ5ICE9PSAnb2JqZWN0JyB8fFxuICAgICFzZWxlY3RWYWx1ZS5xdWVyeS5jbGFzc05hbWUgfHxcbiAgICBPYmplY3Qua2V5cyhzZWxlY3RWYWx1ZSkubGVuZ3RoICE9PSAyXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCAnaW1wcm9wZXIgdXNhZ2Ugb2YgJHNlbGVjdCcpO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IHNlbGVjdFZhbHVlLnF1ZXJ5LnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9IGVsc2UgaWYgKHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICBpZiAoIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICBjb25zdCByYyA9IHRoaXMuY29uZmlnLnJlcXVlc3RDb21wbGV4aXR5O1xuICAgIGlmIChyYyAmJiByYy5zdWJxdWVyeUxpbWl0ID4gMCkge1xuICAgICAgYWRkaXRpb25hbE9wdGlvbnMubGltaXQgPSByYy5zdWJxdWVyeUxpbWl0O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGNoaWxkQ29udGV4dCA9IHsgLi4udGhpcy5jb250ZXh0LCBfc3VicXVlcnlEZXB0aDogKHRoaXMuY29udGV4dC5fc3VicXVlcnlEZXB0aCB8fCAwKSArIDEgfTtcbiAgY29uc3Qgc3VicXVlcnkgPSBhd2FpdCBSZXN0UXVlcnkoe1xuICAgIG1ldGhvZDogUmVzdFF1ZXJ5Lk1ldGhvZC5maW5kLFxuICAgIGNvbmZpZzogdGhpcy5jb25maWcsXG4gICAgYXV0aDogdGhpcy5hdXRoLFxuICAgIGNsYXNzTmFtZTogc2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lLFxuICAgIHJlc3RXaGVyZTogc2VsZWN0VmFsdWUucXVlcnkud2hlcmUsXG4gICAgcmVzdE9wdGlvbnM6IGFkZGl0aW9uYWxPcHRpb25zLFxuICAgIGNvbnRleHQ6IGNoaWxkQ29udGV4dCxcbiAgfSk7XG5cbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICB0cmFuc2Zvcm1TZWxlY3Qoc2VsZWN0T2JqZWN0LCBzZWxlY3RWYWx1ZS5rZXksIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIEtlZXAgcmVwbGFjaW5nICRzZWxlY3QgY2xhdXNlc1xuICAgIHJldHVybiB0aGlzLnJlcGxhY2VTZWxlY3QoKTtcbiAgfSk7XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1Eb250U2VsZWN0ID0gKGRvbnRTZWxlY3RPYmplY3QsIGtleSwgb2JqZWN0cykgPT4ge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiBvYmplY3RzKSB7XG4gICAgdmFsdWVzLnB1c2goa2V5LnNwbGl0KCcuJykucmVkdWNlKGdldERlZXBlc3RPYmplY3RGcm9tS2V5LCByZXN1bHQpKTtcbiAgfVxuICBkZWxldGUgZG9udFNlbGVjdE9iamVjdFsnJGRvbnRTZWxlY3QnXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkoZG9udFNlbGVjdE9iamVjdFsnJG5pbiddKSkge1xuICAgIGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXSA9IGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBkb250U2VsZWN0T2JqZWN0WyckbmluJ10gPSB2YWx1ZXM7XG4gIH1cbn07XG5cbi8vIFJlcGxhY2VzIGEgJGRvbnRTZWxlY3QgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhXG4vLyAkZG9udFNlbGVjdCBjbGF1c2UuXG4vLyBUaGUgJGRvbnRTZWxlY3QgY2xhdXNlIHR1cm5zIGludG8gYW4gJG5pbiB3aXRoIHZhbHVlcyBzZWxlY3RlZCBvdXQgb2Zcbi8vIHRoZSBzdWJxdWVyeS5cbi8vIFJldHVybnMgYSBwb3NzaWJsZS1wcm9taXNlLlxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZURvbnRTZWxlY3QgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIHZhciBkb250U2VsZWN0T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckZG9udFNlbGVjdCcpO1xuICBpZiAoIWRvbnRTZWxlY3RPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgZG9udFNlbGVjdCB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gcXVlcnkgYW5kIGtleVxuICB2YXIgZG9udFNlbGVjdFZhbHVlID0gZG9udFNlbGVjdE9iamVjdFsnJGRvbnRTZWxlY3QnXTtcbiAgaWYgKFxuICAgICFkb250U2VsZWN0VmFsdWUucXVlcnkgfHxcbiAgICAhZG9udFNlbGVjdFZhbHVlLmtleSB8fFxuICAgIHR5cGVvZiBkb250U2VsZWN0VmFsdWUucXVlcnkgIT09ICdvYmplY3QnIHx8XG4gICAgIWRvbnRTZWxlY3RWYWx1ZS5xdWVyeS5jbGFzc05hbWUgfHxcbiAgICBPYmplY3Qua2V5cyhkb250U2VsZWN0VmFsdWUpLmxlbmd0aCAhPT0gMlxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ2ltcHJvcGVyIHVzYWdlIG9mICRkb250U2VsZWN0Jyk7XG4gIH1cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IGRvbnRTZWxlY3RWYWx1ZS5xdWVyeS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmICh0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgY29uc3QgcmMgPSB0aGlzLmNvbmZpZy5yZXF1ZXN0Q29tcGxleGl0eTtcbiAgICBpZiAocmMgJiYgcmMuc3VicXVlcnlMaW1pdCA+IDApIHtcbiAgICAgIGFkZGl0aW9uYWxPcHRpb25zLmxpbWl0ID0gcmMuc3VicXVlcnlMaW1pdDtcbiAgICB9XG4gIH1cblxuICBjb25zdCBjaGlsZENvbnRleHQgPSB7IC4uLnRoaXMuY29udGV4dCwgX3N1YnF1ZXJ5RGVwdGg6ICh0aGlzLmNvbnRleHQuX3N1YnF1ZXJ5RGVwdGggfHwgMCkgKyAxIH07XG4gIGNvbnN0IHN1YnF1ZXJ5ID0gYXdhaXQgUmVzdFF1ZXJ5KHtcbiAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZmluZCxcbiAgICBjb25maWc6IHRoaXMuY29uZmlnLFxuICAgIGF1dGg6IHRoaXMuYXV0aCxcbiAgICBjbGFzc05hbWU6IGRvbnRTZWxlY3RWYWx1ZS5xdWVyeS5jbGFzc05hbWUsXG4gICAgcmVzdFdoZXJlOiBkb250U2VsZWN0VmFsdWUucXVlcnkud2hlcmUsXG4gICAgcmVzdE9wdGlvbnM6IGFkZGl0aW9uYWxPcHRpb25zLFxuICAgIGNvbnRleHQ6IGNoaWxkQ29udGV4dCxcbiAgfSk7XG5cbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICB0cmFuc2Zvcm1Eb250U2VsZWN0KGRvbnRTZWxlY3RPYmplY3QsIGRvbnRTZWxlY3RWYWx1ZS5rZXksIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIEtlZXAgcmVwbGFjaW5nICRkb250U2VsZWN0IGNsYXVzZXNcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlRG9udFNlbGVjdCgpO1xuICB9KTtcbn07XG5cbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLmNsZWFuUmVzdWx0QXV0aERhdGEgPSBmdW5jdGlvbiAocmVzdWx0KSB7XG4gIGRlbGV0ZSByZXN1bHQucGFzc3dvcmQ7XG4gIGlmIChyZXN1bHQuYXV0aERhdGEpIHtcbiAgICBPYmplY3Qua2V5cyhyZXN1bHQuYXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgaWYgKHJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl0gPT09IG51bGwpIHtcbiAgICAgICAgZGVsZXRlIHJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAoT2JqZWN0LmtleXMocmVzdWx0LmF1dGhEYXRhKS5sZW5ndGggPT0gMCkge1xuICAgICAgZGVsZXRlIHJlc3VsdC5hdXRoRGF0YTtcbiAgICB9XG4gIH1cbn07XG5cbmNvbnN0IHJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQgPSBjb25zdHJhaW50ID0+IHtcbiAgaWYgKHR5cGVvZiBjb25zdHJhaW50ICE9PSAnb2JqZWN0Jykge1xuICAgIHJldHVybiBjb25zdHJhaW50O1xuICB9XG4gIGNvbnN0IGVxdWFsVG9PYmplY3QgPSB7fTtcbiAgbGV0IGhhc0RpcmVjdENvbnN0cmFpbnQgPSBmYWxzZTtcbiAgbGV0IGhhc09wZXJhdG9yQ29uc3RyYWludCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IGtleSBpbiBjb25zdHJhaW50KSB7XG4gICAgaWYgKGtleS5pbmRleE9mKCckJykgIT09IDApIHtcbiAgICAgIGhhc0RpcmVjdENvbnN0cmFpbnQgPSB0cnVlO1xuICAgICAgZXF1YWxUb09iamVjdFtrZXldID0gY29uc3RyYWludFtrZXldO1xuICAgIH0gZWxzZSB7XG4gICAgICBoYXNPcGVyYXRvckNvbnN0cmFpbnQgPSB0cnVlO1xuICAgIH1cbiAgfVxuICBpZiAoaGFzRGlyZWN0Q29uc3RyYWludCAmJiBoYXNPcGVyYXRvckNvbnN0cmFpbnQpIHtcbiAgICBjb25zdHJhaW50WyckZXEnXSA9IGVxdWFsVG9PYmplY3Q7XG4gICAgT2JqZWN0LmtleXMoZXF1YWxUb09iamVjdCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgZGVsZXRlIGNvbnN0cmFpbnRba2V5XTtcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gY29uc3RyYWludDtcbn07XG5cbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VFcXVhbGl0eSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHR5cGVvZiB0aGlzLnJlc3RXaGVyZSAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBrZXkgaW4gdGhpcy5yZXN0V2hlcmUpIHtcbiAgICB0aGlzLnJlc3RXaGVyZVtrZXldID0gcmVwbGFjZUVxdWFsaXR5Q29uc3RyYWludCh0aGlzLnJlc3RXaGVyZVtrZXldKTtcbiAgfVxufTtcblxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIHdoZXRoZXIgaXQgd2FzIHN1Y2Nlc3NmdWwuXG4vLyBQb3B1bGF0ZXMgdGhpcy5yZXNwb25zZSB3aXRoIGFuIG9iamVjdCB0aGF0IG9ubHkgaGFzICdyZXN1bHRzJy5cbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnJ1bkZpbmQgPSBhc3luYyBmdW5jdGlvbiAob3B0aW9ucyA9IHt9KSB7XG4gIGlmICh0aGlzLmZpbmRPcHRpb25zLmxpbWl0ID09PSAwKSB7XG4gICAgdGhpcy5yZXNwb25zZSA9IHsgcmVzdWx0czogW10gfTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgY29uc3QgZmluZE9wdGlvbnMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLmZpbmRPcHRpb25zKTtcbiAgaWYgKHRoaXMua2V5cykge1xuICAgIGZpbmRPcHRpb25zLmtleXMgPSB0aGlzLmtleXMubWFwKGtleSA9PiB7XG4gICAgICByZXR1cm4ga2V5LnNwbGl0KCcuJylbMF07XG4gICAgfSk7XG4gICAgLy8gV2hlbiBzZWxlY3RpbmcgYGF1dGhEYXRhYCBvbiBgX1VzZXJgLCBhbHNvIGFkZCB0aGUgaW50ZXJuYWwgYXV0aCBkYXRhIGZpZWxkc1xuICAgIC8vIChlLmcuIGBfYXV0aF9kYXRhX2ZhY2Vib29rYCkgZm9yIGVhY2ggY29uZmlndXJlZCBhdXRoIHByb3ZpZGVyLiBJbiBNb25nb0RCLFxuICAgIC8vIGBhdXRoRGF0YWAgaXMgc3RvcmVkIGFzIGluZGl2aWR1YWwgYF9hdXRoX2RhdGFfPHByb3ZpZGVyPmAgZmllbGRzLCBzbyB0aGVcbiAgICAvLyBwcm9qZWN0aW9uIGZvciBgYXV0aERhdGFgIGFsb25lIHdvbid0IG1hdGNoIHRoZW0uIEFkZGluZyBib3RoIGVuc3VyZXMgaXRcbiAgICAvLyB3b3JrcyBhY3Jvc3MgYWxsIGRhdGFiYXNlIGFkYXB0ZXJzOiBNb25nbyB1c2VzIGBfYXV0aF9kYXRhXypgIGZpZWxkcyxcbiAgICAvLyBQb3N0Z3JlcyB1c2VzIHRoZSBgYXV0aERhdGFgIGNvbHVtbiBkaXJlY3RseS5cbiAgICAvL1xuICAgIC8vIE5vdGU6IFdoZW4gc2VsZWN0aW5nIGBhdXRoRGF0YWAsIG9ubHkgYXV0aCBkYXRhIG9mIGN1cnJlbnRseSBjb25maWd1cmVkXG4gICAgLy8gcHJvdmlkZXJzIGlzIHJldHVybmVkLiBBdXRoIGRhdGEgZW50cmllcyBvZiBwcm92aWRlcnMgdGhhdCBhcmUgbm8gbG9uZ2VyXG4gICAgLy8gY29uZmlndXJlZCB3b24ndCBiZSBpbmNsdWRlZC4gVG8gcmV0dXJuIGFsbCBhdXRoIGRhdGEgcmVnYXJkbGVzcyBvZiB0aGVcbiAgICAvLyBwcm92aWRlciBjb25maWd1cmF0aW9uLCBkbyBub3QgdXNlIGBhdXRoRGF0YWAgYXMgYSBzZWxlY3RlZCBrZXkuXG4gICAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmIGZpbmRPcHRpb25zLmtleXMuaW5jbHVkZXMoJ2F1dGhEYXRhJykpIHtcbiAgICAgIGNvbnN0IHByb3ZpZGVycyA9IHRoaXMuY29uZmlnLmF1dGhEYXRhTWFuYWdlci5nZXRQcm92aWRlcnMoKTtcbiAgICAgIGZvciAoY29uc3QgcHJvdmlkZXIgb2YgcHJvdmlkZXJzKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGBfYXV0aF9kYXRhXyR7cHJvdmlkZXJ9YDtcbiAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy5rZXlzLmluY2x1ZGVzKGtleSkpIHtcbiAgICAgICAgICBmaW5kT3B0aW9ucy5rZXlzLnB1c2goa2V5KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuICBpZiAob3B0aW9ucy5vcCkge1xuICAgIGZpbmRPcHRpb25zLm9wID0gb3B0aW9ucy5vcDtcbiAgfVxuICBjb25zdCByZXN1bHRzID0gYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZCh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZXN0V2hlcmUsIGZpbmRPcHRpb25zLCB0aGlzLmF1dGgpO1xuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiYgIWZpbmRPcHRpb25zLmV4cGxhaW4pIHtcbiAgICBmb3IgKHZhciByZXN1bHQgb2YgcmVzdWx0cykge1xuICAgICAgdGhpcy5jbGVhblJlc3VsdEF1dGhEYXRhKHJlc3VsdCk7XG4gICAgfVxuICB9XG5cbiAgYXdhaXQgdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QodGhpcy5jb25maWcsIHJlc3VsdHMpO1xuXG4gIGlmICh0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lKSB7XG4gICAgZm9yICh2YXIgciBvZiByZXN1bHRzKSB7XG4gICAgICByLmNsYXNzTmFtZSA9IHRoaXMucmVkaXJlY3RDbGFzc05hbWU7XG4gICAgfVxuICB9XG4gIHRoaXMucmVzcG9uc2UgPSB7IHJlc3VsdHM6IHJlc3VsdHMgfTtcbn07XG5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGV0aGVyIGl0IHdhcyBzdWNjZXNzZnVsLlxuLy8gUG9wdWxhdGVzIHRoaXMucmVzcG9uc2UuY291bnQgd2l0aCB0aGUgY291bnRcbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnJ1bkNvdW50ID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuZG9Db3VudCkge1xuICAgIHJldHVybjtcbiAgfVxuICB0aGlzLmZpbmRPcHRpb25zLmNvdW50ID0gdHJ1ZTtcbiAgZGVsZXRlIHRoaXMuZmluZE9wdGlvbnMuc2tpcDtcbiAgZGVsZXRlIHRoaXMuZmluZE9wdGlvbnMubGltaXQ7XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKHRoaXMuY2xhc3NOYW1lLCB0aGlzLnJlc3RXaGVyZSwgdGhpcy5maW5kT3B0aW9ucywgdGhpcy5hdXRoKS50aGVuKGMgPT4ge1xuICAgIHRoaXMucmVzcG9uc2UuY291bnQgPSBjO1xuICB9KTtcbn07XG5cbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLmRlbnlQcm90ZWN0ZWRGaWVsZHMgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIgfHwgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgc2NoZW1hQ29udHJvbGxlciA9IGF3YWl0IHRoaXMuY29uZmlnLmRhdGFiYXNlLmxvYWRTY2hlbWEoKTtcbiAgY29uc3QgcHJvdGVjdGVkRmllbGRzID1cbiAgICB0aGlzLmNvbmZpZy5kYXRhYmFzZS5hZGRQcm90ZWN0ZWRGaWVsZHMoXG4gICAgICBzY2hlbWFDb250cm9sbGVyLFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB0aGlzLnJlc3RXaGVyZSxcbiAgICAgIHRoaXMuZmluZE9wdGlvbnMuYWNsLFxuICAgICAgdGhpcy5hdXRoLFxuICAgICAgdGhpcy5maW5kT3B0aW9uc1xuICAgICkgfHwgW107XG4gIGNvbnN0IGNoZWNrV2hlcmUgPSAod2hlcmUpID0+IHtcbiAgICBpZiAodHlwZW9mIHdoZXJlICE9PSAnb2JqZWN0JyB8fCB3aGVyZSA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHdoZXJlS2V5IG9mIE9iamVjdC5rZXlzKHdoZXJlKSkge1xuICAgICAgY29uc3Qgcm9vdEZpZWxkID0gd2hlcmVLZXkuc3BsaXQoJy4nKVswXTtcbiAgICAgIGlmIChwcm90ZWN0ZWRGaWVsZHMuaW5jbHVkZXMod2hlcmVLZXkpIHx8IHByb3RlY3RlZEZpZWxkcy5pbmNsdWRlcyhyb290RmllbGQpKSB7XG4gICAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgYFRoaXMgdXNlciBpcyBub3QgYWxsb3dlZCB0byBxdWVyeSAke3doZXJlS2V5fSBvbiBjbGFzcyAke3RoaXMuY2xhc3NOYW1lfWAsXG4gICAgICAgICAgdGhpcy5jb25maWdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yIChjb25zdCBvcCBvZiBbJyRvcicsICckYW5kJywgJyRub3InXSkge1xuICAgICAgaWYgKHdoZXJlW29wXSAhPT0gdW5kZWZpbmVkICYmICFBcnJheS5pc0FycmF5KHdoZXJlW29wXSkpIHtcbiAgICAgICAgdGhyb3cgRGF0YWJhc2VDb250cm9sbGVyLmxvZ2ljYWxPcGVyYXRvckVycm9yKG9wLCB3aGVyZVtvcF0pO1xuICAgICAgfVxuICAgICAgaWYgKEFycmF5LmlzQXJyYXkod2hlcmVbb3BdKSkge1xuICAgICAgICB3aGVyZVtvcF0uZm9yRWFjaChzdWJRdWVyeSA9PiBjaGVja1doZXJlKHN1YlF1ZXJ5KSk7XG4gICAgICB9XG4gICAgfVxuICB9O1xuICBjaGVja1doZXJlKHRoaXMucmVzdFdoZXJlKTtcblxuICAvLyBDaGVjayBzb3J0IGtleXMgYWdhaW5zdCBwcm90ZWN0ZWQgZmllbGRzXG4gIGlmICh0aGlzLmZpbmRPcHRpb25zLnNvcnQpIHtcbiAgICBmb3IgKGNvbnN0IHNvcnRLZXkgb2YgT2JqZWN0LmtleXModGhpcy5maW5kT3B0aW9ucy5zb3J0KSkge1xuICAgICAgY29uc3Qgcm9vdEZpZWxkID0gc29ydEtleS5zcGxpdCgnLicpWzBdO1xuICAgICAgaWYgKHByb3RlY3RlZEZpZWxkcy5pbmNsdWRlcyhzb3J0S2V5KSB8fCBwcm90ZWN0ZWRGaWVsZHMuaW5jbHVkZXMocm9vdEZpZWxkKSkge1xuICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgIGBUaGlzIHVzZXIgaXMgbm90IGFsbG93ZWQgdG8gc29ydCBieSAke3NvcnRLZXl9IG9uIGNsYXNzICR7dGhpcy5jbGFzc05hbWV9YCxcbiAgICAgICAgICB0aGlzLmNvbmZpZ1xuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuLy8gQXVnbWVudHMgdGhpcy5yZXNwb25zZSB3aXRoIGFsbCBwb2ludGVycyBvbiBhbiBvYmplY3Rcbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLmhhbmRsZUluY2x1ZGVBbGwgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5pbmNsdWRlQWxsKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5sb2FkU2NoZW1hKClcbiAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuZ2V0T25lU2NoZW1hKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgY29uc3QgaW5jbHVkZUZpZWxkcyA9IFtdO1xuICAgICAgY29uc3Qga2V5RmllbGRzID0gW107XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHNjaGVtYS5maWVsZHMpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIChzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJykgfHxcbiAgICAgICAgICAoc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnQXJyYXknKVxuICAgICAgICApIHtcbiAgICAgICAgICBpbmNsdWRlRmllbGRzLnB1c2goW2ZpZWxkXSk7XG4gICAgICAgICAga2V5RmllbGRzLnB1c2goZmllbGQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBBZGQgZmllbGRzIHRvIGluY2x1ZGUsIGtleXMsIHJlbW92ZSBkdXBzXG4gICAgICB0aGlzLmluY2x1ZGUgPSBbLi4ubmV3IFNldChbLi4udGhpcy5pbmNsdWRlLCAuLi5pbmNsdWRlRmllbGRzXSldO1xuICAgICAgLy8gaWYgdGhpcy5rZXlzIG5vdCBzZXQsIHRoZW4gYWxsIGtleXMgYXJlIGFscmVhZHkgaW5jbHVkZWRcbiAgICAgIGlmICh0aGlzLmtleXMpIHtcbiAgICAgICAgdGhpcy5rZXlzID0gWy4uLm5ldyBTZXQoWy4uLnRoaXMua2V5cywgLi4ua2V5RmllbGRzXSldO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUudmFsaWRhdGVJbmNsdWRlQ29tcGxleGl0eSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCByYyA9IHRoaXMuY29uZmlnLnJlcXVlc3RDb21wbGV4aXR5O1xuICBpZiAoIXJjKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChyYy5pbmNsdWRlRGVwdGggIT09IC0xICYmIHRoaXMuaW5jbHVkZSAmJiB0aGlzLmluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG1heERlcHRoID0gTWF0aC5tYXgoLi4udGhpcy5pbmNsdWRlLm1hcChwYXRoID0+IHBhdGgubGVuZ3RoKSk7XG4gICAgaWYgKG1heERlcHRoID4gcmMuaW5jbHVkZURlcHRoKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYEluY2x1ZGUgZGVwdGggb2YgJHttYXhEZXB0aH0gZXhjZWVkcyBtYXhpbXVtIGFsbG93ZWQgZGVwdGggb2YgJHtyYy5pbmNsdWRlRGVwdGh9YDtcbiAgICAgIGxvZ2dlci53YXJuKG1lc3NhZ2UpO1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksIG1lc3NhZ2UpO1xuICAgIH1cbiAgfVxuICBpZiAocmMuaW5jbHVkZUNvdW50ICE9PSAtMSAmJiB0aGlzLmluY2x1ZGUgJiYgdGhpcy5pbmNsdWRlLmxlbmd0aCA+IHJjLmluY2x1ZGVDb3VudCkge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBgTnVtYmVyIG9mIGluY2x1ZGUgZmllbGRzICgke3RoaXMuaW5jbHVkZS5sZW5ndGh9KSBleGNlZWRzIG1heGltdW0gYWxsb3dlZCAoJHtyYy5pbmNsdWRlQ291bnR9KWA7XG4gICAgbG9nZ2VyLndhcm4obWVzc2FnZSk7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksIG1lc3NhZ2UpO1xuICB9XG59O1xuXG4vLyBVcGRhdGVzIHByb3BlcnR5IGB0aGlzLmtleXNgIHRvIGNvbnRhaW4gYWxsIGtleXMgYnV0IHRoZSBvbmVzIHVuc2VsZWN0ZWQuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVFeGNsdWRlS2V5cyA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmV4Y2x1ZGVLZXlzKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aGlzLmtleXMpIHtcbiAgICB0aGlzLmtleXMgPSB0aGlzLmtleXMuZmlsdGVyKGsgPT4gIXRoaXMuZXhjbHVkZUtleXMuaW5jbHVkZXMoaykpO1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAubG9hZFNjaGVtYSgpXG4gICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYSh0aGlzLmNsYXNzTmFtZSkpXG4gICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkcyA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpO1xuICAgICAgdGhpcy5rZXlzID0gZmllbGRzLmZpbHRlcihrID0+ICF0aGlzLmV4Y2x1ZGVLZXlzLmluY2x1ZGVzKGspKTtcbiAgICB9KTtcbn07XG5cbi8vIEF1Z21lbnRzIHRoaXMucmVzcG9uc2Ugd2l0aCBkYXRhIGF0IHRoZSBwYXRocyBwcm92aWRlZCBpbiB0aGlzLmluY2x1ZGUuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVJbmNsdWRlID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5pbmNsdWRlLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaW5kZXhlZFJlc3VsdHMgPSB0aGlzLnJlc3BvbnNlLnJlc3VsdHMucmVkdWNlKChpbmRleGVkLCByZXN1bHQsIGkpID0+IHtcbiAgICBpbmRleGVkW3Jlc3VsdC5vYmplY3RJZF0gPSBpO1xuICAgIHJldHVybiBpbmRleGVkO1xuICB9LCB7fSk7XG5cbiAgLy8gQnVpbGQgdGhlIGV4ZWN1dGlvbiB0cmVlXG4gIGNvbnN0IGV4ZWN1dGlvblRyZWUgPSB7fVxuICB0aGlzLmluY2x1ZGUuZm9yRWFjaChwYXRoID0+IHtcbiAgICBsZXQgY3VycmVudCA9IGV4ZWN1dGlvblRyZWU7XG4gICAgcGF0aC5mb3JFYWNoKChub2RlKSA9PiB7XG4gICAgICBpZiAoIWN1cnJlbnRbbm9kZV0pIHtcbiAgICAgICAgY3VycmVudFtub2RlXSA9IHtcbiAgICAgICAgICBwYXRoLFxuICAgICAgICAgIGNoaWxkcmVuOiB7fVxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY3VycmVudCA9IGN1cnJlbnRbbm9kZV0uY2hpbGRyZW5cbiAgICB9KTtcbiAgfSk7XG5cbiAgY29uc3QgcmVjdXJzaXZlRXhlY3V0aW9uVHJlZSA9IGFzeW5jICh0cmVlTm9kZSkgPT4ge1xuICAgIGNvbnN0IHsgcGF0aCwgY2hpbGRyZW4gfSA9IHRyZWVOb2RlO1xuICAgIGNvbnN0IHBhdGhSZXNwb25zZSA9IGluY2x1ZGVQYXRoKFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB0aGlzLnJlc3BvbnNlLFxuICAgICAgcGF0aCxcbiAgICAgIHRoaXMuY29udGV4dCxcbiAgICAgIHRoaXMucmVzdE9wdGlvbnMsXG4gICAgICB0aGlzLFxuICAgICk7XG4gICAgaWYgKHBhdGhSZXNwb25zZS50aGVuKSB7XG4gICAgICBjb25zdCBuZXdSZXNwb25zZSA9IGF3YWl0IHBhdGhSZXNwb25zZVxuICAgICAgbmV3UmVzcG9uc2UucmVzdWx0cy5mb3JFYWNoKG5ld09iamVjdCA9PiB7XG4gICAgICAgIC8vIFdlIGh5ZHJhdGUgdGhlIHJvb3Qgb2YgZWFjaCByZXN1bHQgd2l0aCBzdWIgcmVzdWx0c1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3VsdHNbaW5kZXhlZFJlc3VsdHNbbmV3T2JqZWN0Lm9iamVjdElkXV1bcGF0aFswXV0gPSBuZXdPYmplY3RbcGF0aFswXV07XG4gICAgICB9KVxuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhjaGlsZHJlbikubWFwKHJlY3Vyc2l2ZUV4ZWN1dGlvblRyZWUpKTtcbiAgfVxuXG4gIGF3YWl0IFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoZXhlY3V0aW9uVHJlZSkubWFwKHJlY3Vyc2l2ZUV4ZWN1dGlvblRyZWUpKTtcbiAgdGhpcy5pbmNsdWRlID0gW11cbn07XG5cbi8vUmV0dXJucyBhIHByb21pc2Ugb2YgYSBwcm9jZXNzZWQgc2V0IG9mIHJlc3VsdHNcbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnJ1bkFmdGVyRmluZFRyaWdnZXIgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXRoaXMucnVuQWZ0ZXJGaW5kKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyRmluZCcgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJGaW5kSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJGaW5kLFxuICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgKTtcbiAgaWYgKCFoYXNBZnRlckZpbmRIb29rKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFNraXAgQWdncmVnYXRlLCBEaXN0aW5jdCBhbmQgRXhwbGFpbiBRdWVyaWVzXG4gIGlmICh0aGlzLmZpbmRPcHRpb25zLnBpcGVsaW5lIHx8IHRoaXMuZmluZE9wdGlvbnMuZGlzdGluY3QgfHwgdGhpcy5maW5kT3B0aW9ucy5leHBsYWluKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY29uc3QganNvbiA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMucmVzdE9wdGlvbnMpO1xuICBqc29uLndoZXJlID0gdGhpcy5yZXN0V2hlcmU7XG4gIGNvbnN0IHBhcnNlUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkodGhpcy5jbGFzc05hbWUpO1xuICBwYXJzZVF1ZXJ5LndpdGhKU09OKGpzb24pO1xuICAvLyBSdW4gYWZ0ZXJGaW5kIHRyaWdnZXIgYW5kIHNldCB0aGUgbmV3IHJlc3VsdHNcbiAgcmV0dXJuIHRyaWdnZXJzXG4gICAgLm1heWJlUnVuQWZ0ZXJGaW5kVHJpZ2dlcihcbiAgICAgIHRyaWdnZXJzLlR5cGVzLmFmdGVyRmluZCxcbiAgICAgIHRoaXMuYXV0aCxcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgdGhpcy5yZXNwb25zZS5yZXN1bHRzLFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICBwYXJzZVF1ZXJ5LFxuICAgICAgdGhpcy5jb250ZXh0LFxuICAgICAgdGhpcy5pc0dldFxuICAgIClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIC8vIEVuc3VyZSB3ZSBwcm9wZXJseSBzZXQgdGhlIGNsYXNzTmFtZSBiYWNrXG4gICAgICBpZiAodGhpcy5yZWRpcmVjdENsYXNzTmFtZSkge1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3VsdHMgPSByZXN1bHRzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgIGlmIChvYmplY3QgaW5zdGFuY2VvZiBQYXJzZS5PYmplY3QpIHtcbiAgICAgICAgICAgIG9iamVjdCA9IG9iamVjdC50b0pTT04oKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0LmNsYXNzTmFtZSA9IHRoaXMucmVkaXJlY3RDbGFzc05hbWU7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdDtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3VsdHMgPSByZXN1bHRzO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUuaGFuZGxlQXV0aEFkYXB0ZXJzID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicgfHwgdGhpcy5maW5kT3B0aW9ucy5leHBsYWluKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IFByb21pc2UuYWxsKFxuICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cy5tYXAocmVzdWx0ID0+XG4gICAgICB0aGlzLmNvbmZpZy5hdXRoRGF0YU1hbmFnZXIucnVuQWZ0ZXJGaW5kKFxuICAgICAgICB7IGNvbmZpZzogdGhpcy5jb25maWcsIGF1dGg6IHRoaXMuYXV0aCB9LFxuICAgICAgICByZXN1bHQuYXV0aERhdGFcbiAgICAgIClcbiAgICApXG4gICk7XG59O1xuXG4vLyBBZGRzIGluY2x1ZGVkIHZhbHVlcyB0byB0aGUgcmVzcG9uc2UuXG4vLyBQYXRoIGlzIGEgbGlzdCBvZiBmaWVsZCBuYW1lcy5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhbiBhdWdtZW50ZWQgcmVzcG9uc2UuXG5mdW5jdGlvbiBpbmNsdWRlUGF0aChjb25maWcsIGF1dGgsIHJlc3BvbnNlLCBwYXRoLCBjb250ZXh0LCByZXN0T3B0aW9ucyA9IHt9KSB7XG4gIHZhciBwb2ludGVycyA9IGZpbmRQb2ludGVycyhyZXNwb25zZS5yZXN1bHRzLCBwYXRoKTtcbiAgaWYgKHBvaW50ZXJzLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9XG4gIGNvbnN0IHBvaW50ZXJzSGFzaCA9IHt9O1xuICBmb3IgKHZhciBwb2ludGVyIG9mIHBvaW50ZXJzKSB7XG4gICAgaWYgKCFwb2ludGVyKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY2xhc3NOYW1lID0gcG9pbnRlci5jbGFzc05hbWU7XG4gICAgLy8gb25seSBpbmNsdWRlIHRoZSBnb29kIHBvaW50ZXJzXG4gICAgaWYgKGNsYXNzTmFtZSkge1xuICAgICAgcG9pbnRlcnNIYXNoW2NsYXNzTmFtZV0gPSBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXSB8fCBuZXcgU2V0KCk7XG4gICAgICBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXS5hZGQocG9pbnRlci5vYmplY3RJZCk7XG4gICAgfVxuICB9XG4gIGNvbnN0IGluY2x1ZGVSZXN0T3B0aW9ucyA9IHt9O1xuICBpZiAocmVzdE9wdGlvbnMua2V5cykge1xuICAgIGNvbnN0IGtleXMgPSBuZXcgU2V0KHJlc3RPcHRpb25zLmtleXMuc3BsaXQoJywnKSk7XG4gICAgY29uc3Qga2V5U2V0ID0gQXJyYXkuZnJvbShrZXlzKS5yZWR1Y2UoKHNldCwga2V5KSA9PiB7XG4gICAgICBjb25zdCBrZXlQYXRoID0ga2V5LnNwbGl0KCcuJyk7XG4gICAgICBsZXQgaSA9IDA7XG4gICAgICBmb3IgKGk7IGkgPCBwYXRoLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChwYXRoW2ldICE9IGtleVBhdGhbaV0pIHtcbiAgICAgICAgICByZXR1cm4gc2V0O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoaSA8IGtleVBhdGgubGVuZ3RoKSB7XG4gICAgICAgIHNldC5hZGQoa2V5UGF0aFtpXSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2V0O1xuICAgIH0sIG5ldyBTZXQoKSk7XG4gICAgaWYgKGtleVNldC5zaXplID4gMCkge1xuICAgICAgaW5jbHVkZVJlc3RPcHRpb25zLmtleXMgPSBBcnJheS5mcm9tKGtleVNldCkuam9pbignLCcpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChyZXN0T3B0aW9ucy5leGNsdWRlS2V5cykge1xuICAgIGNvbnN0IGV4Y2x1ZGVLZXlzID0gbmV3IFNldChyZXN0T3B0aW9ucy5leGNsdWRlS2V5cy5zcGxpdCgnLCcpKTtcbiAgICBjb25zdCBleGNsdWRlS2V5U2V0ID0gQXJyYXkuZnJvbShleGNsdWRlS2V5cykucmVkdWNlKChzZXQsIGtleSkgPT4ge1xuICAgICAgY29uc3Qga2V5UGF0aCA9IGtleS5zcGxpdCgnLicpO1xuICAgICAgbGV0IGkgPSAwO1xuICAgICAgZm9yIChpOyBpIDwgcGF0aC5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAocGF0aFtpXSAhPSBrZXlQYXRoW2ldKSB7XG4gICAgICAgICAgcmV0dXJuIHNldDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGkgPT0ga2V5UGF0aC5sZW5ndGggLSAxKSB7XG4gICAgICAgIHNldC5hZGQoa2V5UGF0aFtpXSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2V0O1xuICAgIH0sIG5ldyBTZXQoKSk7XG4gICAgaWYgKGV4Y2x1ZGVLZXlTZXQuc2l6ZSA+IDApIHtcbiAgICAgIGluY2x1ZGVSZXN0T3B0aW9ucy5leGNsdWRlS2V5cyA9IEFycmF5LmZyb20oZXhjbHVkZUtleVNldCkuam9pbignLCcpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChyZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UpIHtcbiAgICBpbmNsdWRlUmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gICAgaW5jbHVkZVJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSA9IHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmIChyZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGluY2x1ZGVSZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG4gIGNvbnN0IHF1ZXJ5UHJvbWlzZXMgPSBPYmplY3Qua2V5cyhwb2ludGVyc0hhc2gpLm1hcChhc3luYyBjbGFzc05hbWUgPT4ge1xuICAgIGNvbnN0IG9iamVjdElkcyA9IEFycmF5LmZyb20ocG9pbnRlcnNIYXNoW2NsYXNzTmFtZV0pO1xuICAgIGxldCB3aGVyZTtcbiAgICBpZiAob2JqZWN0SWRzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgd2hlcmUgPSB7IG9iamVjdElkOiBvYmplY3RJZHNbMF0gfTtcbiAgICB9IGVsc2Uge1xuICAgICAgd2hlcmUgPSB7IG9iamVjdElkOiB7ICRpbjogb2JqZWN0SWRzIH0gfTtcbiAgICB9XG4gICAgY29uc3QgcXVlcnkgPSBhd2FpdCBSZXN0UXVlcnkoe1xuICAgICAgbWV0aG9kOiBvYmplY3RJZHMubGVuZ3RoID09PSAxID8gUmVzdFF1ZXJ5Lk1ldGhvZC5nZXQgOiBSZXN0UXVlcnkuTWV0aG9kLmZpbmQsXG4gICAgICBjb25maWcsXG4gICAgICBhdXRoLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgcmVzdFdoZXJlOiB3aGVyZSxcbiAgICAgIHJlc3RPcHRpb25zOiBpbmNsdWRlUmVzdE9wdGlvbnMsXG4gICAgICBjb250ZXh0OiBjb250ZXh0LFxuICAgIH0pO1xuICAgIHJldHVybiBxdWVyeS5leGVjdXRlKHsgb3A6ICdnZXQnIH0pLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICByZXN1bHRzLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzdWx0cyk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIEdldCB0aGUgb2JqZWN0cyBmb3IgYWxsIHRoZXNlIG9iamVjdCBpZHNcbiAgcmV0dXJuIFByb21pc2UuYWxsKHF1ZXJ5UHJvbWlzZXMpLnRoZW4ocmVzcG9uc2VzID0+IHtcbiAgICB2YXIgcmVwbGFjZSA9IHJlc3BvbnNlcy5yZWR1Y2UoKHJlcGxhY2UsIGluY2x1ZGVSZXNwb25zZSkgPT4ge1xuICAgICAgZm9yICh2YXIgb2JqIG9mIGluY2x1ZGVSZXNwb25zZS5yZXN1bHRzKSB7XG4gICAgICAgIG9iai5fX3R5cGUgPSAnT2JqZWN0JztcbiAgICAgICAgb2JqLmNsYXNzTmFtZSA9IGluY2x1ZGVSZXNwb25zZS5jbGFzc05hbWU7XG5cbiAgICAgICAgaWYgKG9iai5jbGFzc05hbWUgPT0gJ19Vc2VyJyAmJiAhYXV0aC5pc01hc3Rlcikge1xuICAgICAgICAgIGRlbGV0ZSBvYmouc2Vzc2lvblRva2VuO1xuICAgICAgICAgIGRlbGV0ZSBvYmouYXV0aERhdGE7XG4gICAgICAgIH1cbiAgICAgICAgcmVwbGFjZVtvYmoub2JqZWN0SWRdID0gb2JqO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlcGxhY2U7XG4gICAgfSwge30pO1xuICAgIHZhciByZXNwID0ge1xuICAgICAgcmVzdWx0czogcmVwbGFjZVBvaW50ZXJzKHJlc3BvbnNlLnJlc3VsdHMsIHBhdGgsIHJlcGxhY2UpLFxuICAgIH07XG4gICAgaWYgKHJlc3BvbnNlLmNvdW50KSB7XG4gICAgICByZXNwLmNvdW50ID0gcmVzcG9uc2UuY291bnQ7XG4gICAgfVxuICAgIHJldHVybiByZXNwO1xuICB9KTtcbn1cblxuLy8gT2JqZWN0IG1heSBiZSBhIGxpc3Qgb2YgUkVTVC1mb3JtYXQgb2JqZWN0IHRvIGZpbmQgcG9pbnRlcnMgaW4sIG9yXG4vLyBpdCBtYXkgYmUgYSBzaW5nbGUgb2JqZWN0LlxuLy8gSWYgdGhlIHBhdGggeWllbGRzIHRoaW5ncyB0aGF0IGFyZW4ndCBwb2ludGVycywgdGhpcyB0aHJvd3MgYW4gZXJyb3IuXG4vLyBQYXRoIGlzIGEgbGlzdCBvZiBmaWVsZHMgdG8gc2VhcmNoIGludG8uXG4vLyBSZXR1cm5zIGEgbGlzdCBvZiBwb2ludGVycyBpbiBSRVNUIGZvcm1hdC5cbmZ1bmN0aW9uIGZpbmRQb2ludGVycyhvYmplY3QsIHBhdGgpIHtcbiAgaWYgKEFycmF5LmlzQXJyYXkob2JqZWN0KSkge1xuICAgIHJldHVybiBvYmplY3QubWFwKHggPT4gZmluZFBvaW50ZXJzKHgsIHBhdGgpKS5mbGF0KCk7XG4gIH1cblxuICBpZiAodHlwZW9mIG9iamVjdCAhPT0gJ29iamVjdCcgfHwgIW9iamVjdCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIGlmIChwYXRoLmxlbmd0aCA9PSAwKSB7XG4gICAgaWYgKG9iamVjdCA9PT0gbnVsbCB8fCBvYmplY3QuX190eXBlID09ICdQb2ludGVyJykge1xuICAgICAgcmV0dXJuIFtvYmplY3RdO1xuICAgIH1cbiAgICByZXR1cm4gW107XG4gIH1cblxuICB2YXIgc3Vib2JqZWN0ID0gb2JqZWN0W3BhdGhbMF1dO1xuICBpZiAoIXN1Ym9iamVjdCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICByZXR1cm4gZmluZFBvaW50ZXJzKHN1Ym9iamVjdCwgcGF0aC5zbGljZSgxKSk7XG59XG5cbi8vIE9iamVjdCBtYXkgYmUgYSBsaXN0IG9mIFJFU1QtZm9ybWF0IG9iamVjdHMgdG8gcmVwbGFjZSBwb2ludGVyc1xuLy8gaW4sIG9yIGl0IG1heSBiZSBhIHNpbmdsZSBvYmplY3QuXG4vLyBQYXRoIGlzIGEgbGlzdCBvZiBmaWVsZHMgdG8gc2VhcmNoIGludG8uXG4vLyByZXBsYWNlIGlzIGEgbWFwIGZyb20gb2JqZWN0IGlkIC0+IG9iamVjdC5cbi8vIFJldHVybnMgc29tZXRoaW5nIGFuYWxvZ291cyB0byBvYmplY3QsIGJ1dCB3aXRoIHRoZSBhcHByb3ByaWF0ZVxuLy8gcG9pbnRlcnMgaW5mbGF0ZWQuXG5mdW5jdGlvbiByZXBsYWNlUG9pbnRlcnMob2JqZWN0LCBwYXRoLCByZXBsYWNlKSB7XG4gIGlmIChBcnJheS5pc0FycmF5KG9iamVjdCkpIHtcbiAgICByZXR1cm4gb2JqZWN0XG4gICAgICAubWFwKG9iaiA9PiByZXBsYWNlUG9pbnRlcnMob2JqLCBwYXRoLCByZXBsYWNlKSlcbiAgICAgIC5maWx0ZXIob2JqID0+IHR5cGVvZiBvYmogIT09ICd1bmRlZmluZWQnKTtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb2JqZWN0ICE9PSAnb2JqZWN0JyB8fCAhb2JqZWN0KSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIGlmIChwYXRoLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChvYmplY3QgJiYgb2JqZWN0Ll9fdHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICByZXR1cm4gcmVwbGFjZVtvYmplY3Qub2JqZWN0SWRdO1xuICAgIH1cbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgdmFyIHN1Ym9iamVjdCA9IG9iamVjdFtwYXRoWzBdXTtcbiAgaWYgKCFzdWJvYmplY3QpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG4gIHZhciBuZXdzdWIgPSByZXBsYWNlUG9pbnRlcnMoc3Vib2JqZWN0LCBwYXRoLnNsaWNlKDEpLCByZXBsYWNlKTtcbiAgdmFyIGFuc3dlciA9IHt9O1xuICBmb3IgKHZhciBrZXkgaW4gb2JqZWN0KSB7XG4gICAgaWYgKGtleSA9PSBwYXRoWzBdKSB7XG4gICAgICBhbnN3ZXJba2V5XSA9IG5ld3N1YjtcbiAgICB9IGVsc2Uge1xuICAgICAgYW5zd2VyW2tleV0gPSBvYmplY3Rba2V5XTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGFuc3dlcjtcbn1cblxuLy8gRmluZHMgYSBzdWJvYmplY3QgdGhhdCBoYXMgdGhlIGdpdmVuIGtleSwgaWYgdGhlcmUgaXMgb25lLlxuLy8gUmV0dXJucyB1bmRlZmluZWQgb3RoZXJ3aXNlLlxuZnVuY3Rpb24gZmluZE9iamVjdFdpdGhLZXkocm9vdCwga2V5KSB7XG4gIGlmICh0eXBlb2Ygcm9vdCAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKEFycmF5LmlzQXJyYXkocm9vdCkpIHtcbiAgICBmb3IgKHZhciBpdGVtIG9mIHJvb3QpIHtcbiAgICAgIGNvbnN0IGFuc3dlciA9IGZpbmRPYmplY3RXaXRoS2V5KGl0ZW0sIGtleSk7XG4gICAgICBpZiAoYW5zd2VyKSB7XG4gICAgICAgIHJldHVybiBhbnN3ZXI7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIEFycmF5cyBhcmUgZnVsbHkgdHJhdmVyc2VkIGFib3ZlOyByZXR1cm5pbmcgaGVyZSBhdm9pZHMgcmUtd2Fsa2luZyB0aGUgc2FtZVxuICAgIC8vIGVsZW1lbnRzIHRocm91Z2ggdGhlIGBmb3IgKHN1YmtleSBpbiByb290KWAgbG9vcCBiZWxvdywgd2hpY2ggd291bGQgbWFrZSB0aGlzXG4gICAgLy8gZnVuY3Rpb24gTygyXm4pIGZvciBuZXN0ZWQgYXJyYXlzIChlLmcuIGRlZXBseSBuZXN0ZWQgJG9yLyRhbmQvJG5vcikuXG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChyb290ICYmIHJvb3Rba2V5XSkge1xuICAgIHJldHVybiByb290O1xuICB9XG4gIGZvciAodmFyIHN1YmtleSBpbiByb290KSB7XG4gICAgY29uc3QgYW5zd2VyID0gZmluZE9iamVjdFdpdGhLZXkocm9vdFtzdWJrZXldLCBrZXkpO1xuICAgIGlmIChhbnN3ZXIpIHtcbiAgICAgIHJldHVybiBhbnN3ZXI7XG4gICAgfVxuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gUmVzdFF1ZXJ5O1xuLy8gRm9yIHRlc3RzXG5tb2R1bGUuZXhwb3J0cy5fVW5zYWZlUmVzdFF1ZXJ5ID0gX1Vuc2FmZVJlc3RRdWVyeTtcbiJdLCJtYXBwaW5ncyI6Ijs7QUFBQTtBQUNBOztBQUVBLElBQUlBLGdCQUFnQixHQUFHQyxPQUFPLENBQUMsZ0NBQWdDLENBQUM7QUFDaEUsTUFBTUMsa0JBQWtCLEdBQUdELE9BQU8sQ0FBQyxrQ0FBa0MsQ0FBQztBQUN0RSxJQUFJRSxLQUFLLEdB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