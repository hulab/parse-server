"use strict";

var _node = require("parse/node");
var _lodash = _interopRequireDefault(require("lodash"));
var _intersect = _interopRequireDefault(require("intersect"));
var _logger = _interopRequireDefault(require("../logger"));
var _Utils = _interopRequireDefault(require("../Utils"));
var SchemaController = _interopRequireWildcard(require("./SchemaController"));
var _StorageAdapter = require("../Adapters/Storage/StorageAdapter");
var _MongoStorageAdapter = _interopRequireDefault(require("../Adapters/Storage/Mongo/MongoStorageAdapter"));
var _PostgresStorageAdapter = _interopRequireDefault(require("../Adapters/Storage/Postgres/PostgresStorageAdapter"));
var _SchemaCache = _interopRequireDefault(require("../Adapters/Cache/SchemaCache"));
var _Error = require("../Error");
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// A database adapter that works with data exported from the hosted
// Parse database.
// -disable-next
// -disable-next
// -disable-next
// Query operators that always pass validation regardless of auth level.
const queryOperators = ['$and', '$or', '$nor'];

// Registry of internal fields with access permissions.
// Internal fields are never directly writable by clients, so clientWrite is omitted.
// - clientRead: any client can use this field in queries
// - masterRead: master key can use this field in queries
// - masterWrite: master key can use this field in updates
const internalFields = {
  _rperm: {
    clientRead: true,
    masterRead: true,
    masterWrite: true
  },
  _wperm: {
    clientRead: true,
    masterRead: true,
    masterWrite: true
  },
  _hashed_password: {
    clientRead: false,
    masterRead: false,
    masterWrite: true
  },
  _email_verify_token: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _perishable_token: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _perishable_token_expires_at: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _email_verify_token_expires_at: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _failed_login_count: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _account_lockout_expires_at: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _password_changed_at: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _password_history: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _tombstone: {
    clientRead: false,
    masterRead: true,
    masterWrite: false
  },
  _session_token: {
    clientRead: false,
    masterRead: true,
    masterWrite: false
  }
  /////////////////////////////////////////////////////////////////////////////////////////////
  // The following fields are not accessed by their _-prefixed name through the API;
  // they are mapped to REST-level names in the adapter layer or handled through
  // separate code paths.
  /////////////////////////////////////////////////////////////////////////////////////////////
  // System fields (mapped to REST-level names):
  // _id (objectId)
  // _created_at (createdAt)
  // _updated_at (updatedAt)
  // _last_used (lastUsed)
  // _expiresAt (expiresAt)
  /////////////////////////////////////////////////////////////////////////////////////////////
  // Legacy ACL format: mapped to/from _rperm/_wperm
  // _acl
  /////////////////////////////////////////////////////////////////////////////////////////////
  // Schema metadata: not data fields, used only for schema configuration
  // _metadata
  // _client_permissions
  /////////////////////////////////////////////////////////////////////////////////////////////
  // Dynamic auth data fields: used only in projections and updates, not in queries
  // _auth_data_<provider>
};

// Derived access lists
const specialQueryKeys = [...queryOperators, ...Object.keys(internalFields).filter(k => internalFields[k].clientRead)];
const specialMasterQueryKeys = [...queryOperators, ...Object.keys(internalFields).filter(k => internalFields[k].masterRead)];
function addWriteACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query);
  //Can't be any existing '_wperm' query, we don't allow client queries on that, no need to $and
  newQuery._wperm = {
    $in: [null, ...acl]
  };
  return newQuery;
}
function addReadACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query);
  //Can't be any existing '_rperm' query, we don't allow client queries on that, no need to $and
  newQuery._rperm = {
    $in: [null, '*', ...acl]
  };
  return newQuery;
}

// Transforms a REST API formatted ACL object to our two-field mongo format.
const transformObjectACL = ({
  ACL,
  ...result
}) => {
  if (!ACL) {
    return result;
  }
  result._wperm = [];
  result._rperm = [];
  for (const entry in ACL) {
    if (ACL[entry].read) {
      result._rperm.push(entry);
    }
    if (ACL[entry].write) {
      result._wperm.push(entry);
    }
  }
  return result;
};
const validateQuery = (query, isMaster, isMaintenance, update, options, _depth = 0) => {
  if (isMaintenance) {
    isMaster = true;
  }
  const rc = options?.requestComplexity;
  if (!isMaster && rc && rc.queryDepth !== -1 && _depth > rc.queryDepth) {
    throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, `Query condition nesting depth exceeds maximum allowed depth of ${rc.queryDepth}`);
  }
  if (query.ACL) {
    throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Cannot query on ACL.');
  }
  if (query.$or) {
    if (Array.isArray(query.$or)) {
      query.$or.forEach(value => validateQuery(value, isMaster, isMaintenance, update, options, _depth + 1));
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $or format - use an array value.');
    }
  }
  if (query.$and) {
    if (Array.isArray(query.$and)) {
      query.$and.forEach(value => validateQuery(value, isMaster, isMaintenance, update, options, _depth + 1));
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $and format - use an array value.');
    }
  }
  if (query.$nor) {
    if (Array.isArray(query.$nor) && query.$nor.length > 0) {
      query.$nor.forEach(value => validateQuery(value, isMaster, isMaintenance, update, options, _depth + 1));
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $nor format - use an array of at least 1 value.');
    }
  }
  Object.keys(query).forEach(key => {
    if (query && query[key] && query[key].$regex !== undefined) {
      if (!isMaster && rc && rc.allowRegex === false) {
        throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, '$regex operator is not allowed');
      }
      if (typeof query[key].$regex !== 'string') {
        throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, '$regex value must be a string');
      }
      if (query[key].$options !== undefined && typeof query[key].$options !== 'string') {
        throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, '$options value must be a string');
      }
      if (typeof query[key].$options === 'string') {
        if (!query[key].$options.match(/^[imxsu]+$/)) {
          throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, `Bad $options value for query: ${query[key].$options}`);
        }
      }
    }
    if (!key.match(/^[a-zA-Z][a-zA-Z0-9_\.]*$/) && !specialQueryKeys.includes(key) && !(isMaster && specialMasterQueryKeys.includes(key))) {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid key name: ${key}`);
    }
  });
};

// Filters out any data that shouldn't be on this REST-formatted object.
const filterSensitiveData = (isMaster, isMaintenance, aclGroup, auth, operation, schema, className, protectedFields, object, protectedFieldsOwnerExempt) => {
  let userId = null;
  if (auth && auth.user) {
    userId = auth.user.id;
  }

  // replace protectedFields when using pointer-permissions
  const perms = schema && schema.getClassLevelPermissions ? schema.getClassLevelPermissions(className) : {};
  if (perms) {
    const isReadOperation = ['get', 'find'].indexOf(operation) > -1;
    if (isReadOperation && perms.protectedFields) {
      // extract protectedFields added with the pointer-permission prefix
      const protectedFieldsPointerPerm = Object.keys(perms.protectedFields).filter(key => key.startsWith('userField:')).map(key => {
        return {
          key: key.substring(10),
          value: perms.protectedFields[key]
        };
      });
      const newProtectedFields = [];
      let overrideProtectedFields = false;

      // check if the object grants the current user access based on the extracted fields
      protectedFieldsPointerPerm.forEach(pointerPerm => {
        let pointerPermIncludesUser = false;
        const readUserFieldValue = object[pointerPerm.key];
        if (readUserFieldValue) {
          if (Array.isArray(readUserFieldValue)) {
            pointerPermIncludesUser = readUserFieldValue.some(user => user.objectId && user.objectId === userId);
          } else {
            pointerPermIncludesUser = readUserFieldValue.objectId && readUserFieldValue.objectId === userId;
          }
        }
        if (pointerPermIncludesUser) {
          overrideProtectedFields = true;
          newProtectedFields.push(pointerPerm.value);
        }
      });

      // if at least one pointer-permission affected the current user
      // intersect vs protectedFields from previous stage (@see addProtectedFields)
      // Sets theory (intersections): A x (B x C) == (A x B) x C
      if (overrideProtectedFields && protectedFields) {
        newProtectedFields.push(protectedFields);
      }
      // intersect all sets of protectedFields
      newProtectedFields.forEach(fields => {
        if (fields) {
          // if there're no protctedFields by other criteria ( id / role / auth)
          // then we must intersect each set (per userField)
          if (!protectedFields) {
            protectedFields = fields;
          } else {
            protectedFields = protectedFields.filter(v => fields.includes(v));
          }
        }
      });
    }
  }
  const isUserClass = className === '_User';
  if (isUserClass) {
    object.password = object._hashed_password;
    delete object._hashed_password;
    delete object.sessionToken;
  }
  if (isMaintenance) {
    return object;
  }

  /* special treat for the user class: don't filter protectedFields if currently loggedin user is
  the retrieved user, unless protectedFieldsOwnerExempt is false */
  const isOwnerExempt = protectedFieldsOwnerExempt !== false && isUserClass && userId && object.objectId === userId;
  if (!isOwnerExempt) {
    protectedFields && protectedFields.forEach(k => delete object[k]);

    // fields not requested by client (excluded),
    // but were needed to apply protectedFields
    perms?.protectedFields?.temporaryKeys?.forEach(k => delete object[k]);
  }
  for (const key in object) {
    if (key.charAt(0) === '_') {
      delete object[key];
    }
  }
  if (!isUserClass || isMaster) {
    return object;
  }
  if (aclGroup.indexOf(object.objectId) > -1) {
    return object;
  }
  delete object.authData;
  return object;
};

// Runs an update on the database.
// Returns a promise for an object with the new values for field
// modifications that don't know their results ahead of time, like
// 'increment'.
// Options:
//   acl:  a list of strings. If the object to be updated has an ACL,
//         one of the provided strings must provide the caller with
//         write permissions.
const specialKeysForUpdate = Object.keys(internalFields).filter(k => internalFields[k].masterWrite);
const isSpecialUpdateKey = key => {
  return specialKeysForUpdate.indexOf(key) >= 0;
};
function joinTableName(className, key) {
  return `_Join:${key}:${className}`;
}
const flattenUpdateOperatorsForCreate = object => {
  for (const key in object) {
    if (object[key] && object[key].__op) {
      switch (object[key].__op) {
        case 'Increment':
          if (typeof object[key].amount !== 'number') {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }
          object[key] = object[key].amount;
          break;
        case 'SetOnInsert':
          object[key] = object[key].amount;
          break;
        case 'Add':
          if (!Array.isArray(object[key].objects)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }
          object[key] = object[key].objects;
          break;
        case 'AddUnique':
          if (!Array.isArray(object[key].objects)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }
          object[key] = object[key].objects;
          break;
        case 'Remove':
          if (!Array.isArray(object[key].objects)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }
          object[key] = [];
          break;
        case 'Delete':
          delete object[key];
          break;
        default:
          throw new _node.Parse.Error(_node.Parse.Error.COMMAND_UNAVAILABLE, `The ${object[key].__op} operator is not supported yet.`);
      }
    }
  }
};
const transformAuthData = (className, object, schema) => {
  if (object.authData && className === '_User') {
    Object.keys(object.authData).forEach(provider => {
      const providerData = object.authData[provider];
      const fieldName = `_auth_data_${provider}`;
      if (providerData == null) {
        object[fieldName] = {
          __op: 'Delete'
        };
      } else {
        object[fieldName] = providerData;
        schema.fields[fieldName] = {
          type: 'Object'
        };
      }
    });
    delete object.authData;
  }
};
// Transforms a Database format ACL to a REST API format ACL
const untransformObjectACL = ({
  _rperm,
  _wperm,
  ...output
}) => {
  if (_rperm || _wperm) {
    output.ACL = {};
    (_rperm || []).forEach(entry => {
      if (!output.ACL[entry]) {
        output.ACL[entry] = {
          read: true
        };
      } else {
        output.ACL[entry]['read'] = true;
      }
    });
    (_wperm || []).forEach(entry => {
      if (!output.ACL[entry]) {
        output.ACL[entry] = {
          write: true
        };
      } else {
        output.ACL[entry]['write'] = true;
      }
    });
  }
  return output;
};

/**
 * When querying, the fieldName may be compound, extract the root fieldName
 *     `temperature.celsius` becomes `temperature`
 * @param {string} fieldName that may be a compound field name
 * @returns {string} the root name of the field
 */
const getRootFieldName = fieldName => {
  return fieldName.split('.')[0];
};
const relationSchema = {
  fields: {
    relatedId: {
      type: 'String'
    },
    owningId: {
      type: 'String'
    }
  }
};
const convertEmailToLowercase = (object, className, options) => {
  if (className === '_User' && options.convertEmailToLowercase) {
    if (typeof object['email'] === 'string') {
      object['email'] = object['email'].toLowerCase();
    }
  }
};
const convertUsernameToLowercase = (object, className, options) => {
  if (className === '_User' && options.convertUsernameToLowercase) {
    if (typeof object['username'] === 'string') {
      object['username'] = object['username'].toLowerCase();
    }
  }
};
class DatabaseController {
  constructor(adapter, options) {
    this.adapter = adapter;
    this.options = options || {};
    this.idempotencyOptions = this.options.idempotencyOptions || {};
    // Prevent mutable this.schema, otherwise one request could use
    // multiple schemas, so instead use loadSchema to get a schema.
    this.schemaPromise = null;
    this._transactionalSession = null;
    this.options = options;
  }
  collectionExists(className) {
    return this.adapter.classExists(className);
  }
  purgeCollection(className) {
    return this.loadSchema().then(schemaController => schemaController.getOneSchema(className)).then(schema => this.adapter.deleteObjectsByQuery(className, schema, {}));
  }
  validateClassName(className) {
    if (!SchemaController.classNameIsValid(className)) {
      return Promise.reject(new _node.Parse.Error(_node.Parse.Error.INVALID_CLASS_NAME, 'invalid className: ' + className));
    }
    return Promise.resolve();
  }

  // Returns a promise for a schemaController.
  loadSchema(options = {
    clearCache: false
  }) {
    if (this.schemaPromise != null) {
      return this.schemaPromise;
    }
    this.schemaPromise = SchemaController.load(this.adapter, options);
    this.schemaPromise.then(() => delete this.schemaPromise, () => delete this.schemaPromise);
    return this.loadSchema(options);
  }
  loadSchemaIfNeeded(schemaController, options = {
    clearCache: false
  }) {
    return schemaController ? Promise.resolve(schemaController) : this.loadSchema(options);
  }

  // Returns a promise for the classname that is related to the given
  // classname through the key.
  // TODO: make this not in the DatabaseController interface
  redirectClassNameForKey(className, key) {
    return this.loadSchema().then(schema => {
      var t = schema.getExpectedType(className, key);
      if (t != null && typeof t !== 'string' && t.type === 'Relation') {
        return t.targetClass;
      }
      return className;
    });
  }

  // Uses the schema to validate the object (REST API format).
  // Returns a promise that resolves to the new schema.
  // This does not update this.schema, because in a situation like a
  // batch request, that could confuse other users of the schema.
  validateObject(className, object, query, runOptions, maintenance) {
    let schema;
    const acl = runOptions.acl;
    const isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchema().then(s => {
      schema = s;
      if (isMaster) {
        return Promise.resolve();
      }
      return this.canAddField(schema, className, object, aclGroup, runOptions);
    }).then(() => {
      return schema.validateObject(className, object, query, maintenance);
    });
  }

  /**
   * Updates objects in the database that match the given query.
   * @param {Object} options
   * @param {boolean} [options.many=false] When true, updates all matching documents
   *   and returns `{ matchedCount, modifiedCount }` where values are numbers if the
   *   storage adapter supports `UpdateManyResult`, or `undefined` otherwise.
   */
  update(className, query, update, {
    acl,
    many,
    upsert,
    addsField
  } = {}, skipSanitization = false, validateOnly = false, validSchemaController) {
    try {
      _Utils.default.checkProhibitedKeywords(this.options, update);
    } catch (error) {
      return Promise.reject(new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `${error}`));
    }
    try {
      const {
        validateFileUrlsInObject
      } = require('../FileUrlValidator');
      validateFileUrlsInObject(update, this.options);
    } catch (error) {
      return Promise.reject(error instanceof _node.Parse.Error ? error : new _node.Parse.Error(_node.Parse.Error.FILE_SAVE_ERROR, error.message || error));
    }
    const originalQuery = query;
    const originalUpdate = update;
    // Make a copy of the object, so we don't mutate the incoming data.
    update = structuredClone(update);
    var relationUpdates = [];
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'update')).then(() => {
        relationUpdates = this.collectRelationUpdates(className, originalQuery.objectId, update);
        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'update', query, aclGroup);
          if (addsField) {
            query = {
              $and: [query, this.addPointerPermissions(schemaController, className, 'addField', query, aclGroup)]
            };
          }
        }
        if (!query) {
          return Promise.resolve();
        }
        if (acl) {
          query = addWriteACL(query, acl);
        }
        validateQuery(query, isMaster, false, true, this.options);
        return schemaController.getOneSchema(className, true).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }
          throw error;
        }).then(schema => {
          Object.keys(update).forEach(fieldName => {
            if (fieldName.match(/^authData\./)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }
            const rootFieldName = getRootFieldName(fieldName);
            if (!SchemaController.fieldNameIsValid(rootFieldName, className) && !isSpecialUpdateKey(rootFieldName)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }
          });
          for (const updateOperation in update) {
            if (update[updateOperation] && typeof update[updateOperation] === 'object' && Object.keys(update[updateOperation]).some(innerKey => innerKey.includes('$') || innerKey.includes('.'))) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
            }
          }
          update = transformObjectACL(update);
          convertEmailToLowercase(update, className, this.options);
          convertUsernameToLowercase(update, className, this.options);
          transformAuthData(className, update, schema);
          if (validateOnly) {
            return this.adapter.find(className, schema, query, {
              readPreference: 'primary'
            }).then(result => {
              if (!result || !result.length) {
                throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
              }
              return {};
            });
          }
          if (many) {
            return this.adapter.updateObjectsByQuery(className, schema, query, update, this._transactionalSession);
          } else if (upsert) {
            return this.adapter.upsertOneObject(className, schema, query, update, this._transactionalSession);
          } else {
            return this.adapter.findOneAndUpdate(className, schema, query, update, this._transactionalSession);
          }
        });
      }).then(result => {
        if (!result) {
          throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
        }
        if (validateOnly) {
          return result;
        }
        return this.handleRelationUpdates(className, originalQuery.objectId, update, relationUpdates).then(() => {
          return result;
        });
      }).then(result => {
        if (skipSanitization) {
          return Promise.resolve(result);
        }
        if (many) {
          return {
            matchedCount: typeof result?.matchedCount === 'number' ? result.matchedCount : undefined,
            modifiedCount: typeof result?.modifiedCount === 'number' ? result.modifiedCount : undefined
          };
        }
        return this._sanitizeDatabaseResult(originalUpdate, result);
      });
    });
  }

  // Collect all relation-updating operations from a REST-format update.
  // Returns a list of all relation updates to perform
  // This mutates update.
  collectRelationUpdates(className, objectId, update) {
    var ops = [];
    var deleteMe = [];
    objectId = update.objectId || objectId;
    var process = (op, key) => {
      if (!op) {
        return;
      }
      if (op.__op == 'AddRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }
      if (op.__op == 'RemoveRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }
      if (op.__op == 'Batch') {
        for (var x of op.ops) {
          process(x, key);
        }
      }
    };
    for (const key in update) {
      process(update[key], key);
    }
    for (const key of deleteMe) {
      delete update[key];
    }
    return ops;
  }

  // Processes relation-updating operations from a REST-format update.
  // Returns a promise that resolves when all updates have been performed
  handleRelationUpdates(className, objectId, update, ops) {
    var pending = [];
    objectId = update.objectId || objectId;
    ops.forEach(({
      key,
      op
    }) => {
      if (!op) {
        return;
      }
      if (op.__op == 'AddRelation') {
        for (const object of op.objects) {
          pending.push(this.addRelation(key, className, objectId, object.objectId));
        }
      }
      if (op.__op == 'RemoveRelation') {
        for (const object of op.objects) {
          pending.push(this.removeRelation(key, className, objectId, object.objectId));
        }
      }
    });
    return Promise.all(pending);
  }

  // Adds a relation.
  // Returns a promise that resolves successfully iff the add was successful.
  addRelation(key, fromClassName, fromId, toId) {
    const doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.upsertOneObject(`_Join:${key}:${fromClassName}`, relationSchema, doc, doc, this._transactionalSession);
  }

  // Removes a relation.
  // Returns a promise that resolves successfully iff the remove was
  // successful.
  removeRelation(key, fromClassName, fromId, toId) {
    var doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.deleteObjectsByQuery(`_Join:${key}:${fromClassName}`, relationSchema, doc, this._transactionalSession).catch(error => {
      // We don't care if they try to delete a non-existent relation.
      if (error.code == _node.Parse.Error.OBJECT_NOT_FOUND) {
        return;
      }
      throw error;
    });
  }

  // Removes objects matches this query from the database.
  // Returns a promise that resolves successfully iff the object was
  // deleted.
  // Options:
  //   acl:  a list of strings. If the object to be updated has an ACL,
  //         one of the provided strings must provide the caller with
  //         write permissions.
  destroy(className, query, {
    acl
  } = {}, validSchemaController) {
    const isMaster = acl === undefined;
    const aclGroup = acl || [];
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'delete')).then(() => {
        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'delete', query, aclGroup);
          if (!query) {
            throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
          }
        }
        // delete by query
        if (acl) {
          query = addWriteACL(query, acl);
        }
        validateQuery(query, isMaster, false, false, this.options);
        return schemaController.getOneSchema(className).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }
          throw error;
        }).then(parseFormatSchema => this.adapter.deleteObjectsByQuery(className, parseFormatSchema, query, this._transactionalSession)).catch(error => {
          // When deleting sessions while changing passwords, don't throw an error if they don't have any sessions.
          if (className === '_Session' && error.code === _node.Parse.Error.OBJECT_NOT_FOUND) {
            return Promise.resolve({});
          }
          throw error;
        });
      });
    });
  }

  // Inserts an object into the database.
  // Returns a promise that resolves successfully iff the object saved.
  create(className, object, {
    acl
  } = {}, validateOnly = false, validSchemaController) {
    try {
      _Utils.default.checkProhibitedKeywords(this.options, object);
    } catch (error) {
      return Promise.reject(new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `${error}`));
    }
    try {
      const {
        validateFileUrlsInObject
      } = require('../FileUrlValidator');
      validateFileUrlsInObject(object, this.options);
    } catch (error) {
      return Promise.reject(error instanceof _node.Parse.Error ? error : new _node.Parse.Error(_node.Parse.Error.FILE_SAVE_ERROR, error.message || error));
    }
    // Make a copy of the object, so we don't mutate the incoming data.
    const originalObject = object;
    object = transformObjectACL(object);
    convertEmailToLowercase(object, className, this.options);
    convertUsernameToLowercase(object, className, this.options);
    object.createdAt = {
      iso: object.createdAt,
      __type: 'Date'
    };
    object.updatedAt = {
      iso: object.updatedAt,
      __type: 'Date'
    };
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    const relationUpdates = this.collectRelationUpdates(className, null, object);
    return this.validateClassName(className).then(() => this.loadSchemaIfNeeded(validSchemaController)).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'create')).then(() => schemaController.enforceClassExists(className)).then(() => schemaController.getOneSchema(className, true)).then(schema => {
        transformAuthData(className, object, schema);
        flattenUpdateOperatorsForCreate(object);
        if (validateOnly) {
          return {};
        }
        return this.adapter.createObject(className, SchemaController.convertSchemaToAdapterSchema(schema), object, this._transactionalSession);
      }).then(result => {
        if (validateOnly) {
          return originalObject;
        }
        return this.handleRelationUpdates(className, object.objectId, object, relationUpdates).then(() => {
          return this._sanitizeDatabaseResult(originalObject, result.ops[0]);
        });
      });
    });
  }
  canAddField(schema, className, object, aclGroup, runOptions) {
    const classSchema = schema.schemaData[className];
    if (!classSchema) {
      return Promise.resolve();
    }
    const fields = Object.keys(object);
    const schemaFields = Object.keys(classSchema.fields);
    const newKeys = fields.filter(field => {
      // Skip fields that are unset
      if (object[field] && object[field].__op && object[field].__op === 'Delete') {
        return false;
      }
      return schemaFields.indexOf(getRootFieldName(field)) < 0;
    });
    if (newKeys.length > 0) {
      // adds a marker that new field is being adding during update
      runOptions.addsField = true;
      const action = runOptions.action;
      return schema.validatePermission(className, aclGroup, 'addField', action);
    }
    return Promise.resolve();
  }

  // Won't delete collections in the system namespace
  /**
   * Delete all classes and clears the schema cache
   *
   * @param {boolean} fast set to true if it's ok to just delete rows and not indexes
   * @returns {Promise<void>} when the deletions completes
   */
  deleteEverything(fast = false) {
    this.schemaPromise = null;
    _SchemaCache.default.clear();
    return this.adapter.deleteAllClasses(fast);
  }

  // Returns a promise for a list of related ids given an owning id.
  // className here is the owning className.
  relatedIds(className, key, owningId, queryOptions) {
    const {
      skip,
      limit,
      sort
    } = queryOptions;
    const findOptions = {};
    if (sort && sort.createdAt && this.adapter.canSortOnJoinTables) {
      findOptions.sort = {
        _id: sort.createdAt
      };
      findOptions.limit = limit;
      findOptions.skip = skip;
      queryOptions.skip = 0;
    }
    return this.adapter.find(joinTableName(className, key), relationSchema, {
      owningId
    }, findOptions).then(results => results.map(result => result.relatedId));
  }

  // Returns a promise for a list of owning ids given some related ids.
  // className here is the owning className.
  owningIds(className, key, relatedIds) {
    return this.adapter.find(joinTableName(className, key), relationSchema, {
      relatedId: {
        $in: relatedIds
      }
    }, {
      keys: ['owningId']
    }).then(results => results.map(result => result.owningId));
  }

  // Modifies query so that it no longer has $in on relation fields, or
  // equal-to-pointer constraints on relation fields.
  // Returns a promise that resolves when query is mutated
  reduceInRelation(className, query, schema) {
    // Search for an in-relation or equal-to-relation
    // Make it sequential for now, not sure of paralleization side effects
    const promises = [];
    if (query['$or']) {
      const ors = query['$or'];
      promises.push(...ors.map((aQuery, index) => {
        return this.reduceInRelation(className, aQuery, schema).then(aQuery => {
          query['$or'][index] = aQuery;
        });
      }));
    }
    if (query['$and']) {
      const ands = query['$and'];
      promises.push(...ands.map((aQuery, index) => {
        return this.reduceInRelation(className, aQuery, schema).then(aQuery => {
          query['$and'][index] = aQuery;
        });
      }));
    }
    const otherKeys = Object.keys(query).map(key => {
      if (key === '$and' || key === '$or') {
        return;
      }
      const t = schema.getExpectedType(className, key);
      if (!t || t.type !== 'Relation') {
        return Promise.resolve(query);
      }
      let queries = null;
      if (query[key] && (query[key]['$in'] || query[key]['$ne'] || query[key]['$nin'] || query[key].__type == 'Pointer')) {
        // Build the list of queries
        queries = Object.keys(query[key]).map(constraintKey => {
          let relatedIds;
          let isNegation = false;
          if (constraintKey === 'objectId') {
            relatedIds = [query[key].objectId];
          } else if (constraintKey == '$in') {
            relatedIds = query[key]['$in'].map(r => r.objectId);
          } else if (constraintKey == '$nin') {
            isNegation = true;
            relatedIds = query[key]['$nin'].map(r => r.objectId);
          } else if (constraintKey == '$ne') {
            isNegation = true;
            relatedIds = [query[key]['$ne'].objectId];
          } else {
            return;
          }
          return {
            isNegation,
            relatedIds
          };
        });
      } else {
        queries = [{
          isNegation: false,
          relatedIds: []
        }];
      }

      // remove the current queryKey as we don,t need it anymore
      delete query[key];
      // execute each query independently to build the list of
      // $in / $nin
      const promises = queries.map(q => {
        if (!q) {
          return Promise.resolve();
        }
        return this.owningIds(className, key, q.relatedIds).then(ids => {
          if (q.isNegation) {
            this.addNotInObjectIdsIds(ids, query);
          } else {
            this.addInObjectIdsIds(ids, query);
          }
          return Promise.resolve();
        });
      });
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      });
    });
    return Promise.all([...promises, ...otherKeys]).then(() => {
      return Promise.resolve(query);
    });
  }

  // Modifies query so that it no longer has $relatedTo
  // Returns a promise that resolves when query is mutated
  reduceRelationKeys(className, query, queryOptions, auth = {}, aclGroup = [], isMaster = false, schemaController) {
    if (query['$or']) {
      return Promise.all(query['$or'].map(aQuery => {
        return this.reduceRelationKeys(className, aQuery, queryOptions, auth, aclGroup, isMaster, schemaController);
      }));
    }
    if (query['$and']) {
      return Promise.all(query['$and'].map(aQuery => {
        return this.reduceRelationKeys(className, aQuery, queryOptions, auth, aclGroup, isMaster, schemaController);
      }));
    }
    if (Array.isArray(query['$nor'])) {
      // Guard with Array.isArray (unlike the legacy $or/$and checks above) so a
      // malformed non-array $nor still falls through to validateQuery and yields
      // the existing INVALID_QUERY error instead of throwing here.
      return Promise.all(query['$nor'].map(aQuery => {
        return this.reduceRelationKeys(className, aQuery, queryOptions, auth, aclGroup, isMaster, schemaController);
      }));
    }
    var relatedTo = query['$relatedTo'];
    if (relatedTo) {
      return this.authorizeRelatedToQuery(relatedTo, auth, aclGroup, isMaster, schemaController).then(canReadOwningObject => {
        delete query['$relatedTo'];
        if (!canReadOwningObject) {
          // The caller is not allowed to read the owning object, so the
          // relation must not disclose any linked objects (and must not act
          // as a membership oracle for a known related id).
          this.addInObjectIdsIds([], query);
          return this.reduceRelationKeys(className, query, queryOptions, auth, aclGroup, isMaster, schemaController);
        }
        return this.relatedIds(relatedTo.object.className, relatedTo.key, relatedTo.object.objectId, queryOptions).then(ids => {
          this.addInObjectIdsIds(ids, query);
          return this.reduceRelationKeys(className, query, queryOptions, auth, aclGroup, isMaster, schemaController);
        });
      }).then(() => {});
    }
  }

  // Authorizes a `$relatedTo` relation query against the owning object before
  // its join table is read by `relatedIds`. Without this check, `$relatedTo`
  // bypasses both `protectedFields` and the owning object's ACL/CLP, because
  // the downstream protected-field and ACL filters only apply to the queried
  // (target) class, never to the owning class referenced by `$relatedTo`.
  //
  // - Throws `OPERATION_FORBIDDEN` if the relation key is a protected field on
  //   the owning class for the caller's auth context (mirrors the protected
  //   WHERE-field denial in `RestQuery.denyProtectedFields`).
  // - Resolves to `true` if the caller may read the owning object (so the join
  //   table read may proceed), or `false` otherwise (so the relation yields no
  //   results and cannot be used as a membership oracle).
  //
  // Master and maintenance requests bypass both checks by design.
  authorizeRelatedToQuery(relatedTo, auth = {}, aclGroup = [], isMaster = false, schemaController) {
    if (isMaster) {
      return Promise.resolve(true);
    }
    const owningClassName = relatedTo && relatedTo.object && relatedTo.object.className;
    const owningId = relatedTo && relatedTo.object && relatedTo.object.objectId;
    const relationKey = relatedTo && relatedTo.key;
    return this.loadSchemaIfNeeded(schemaController).then(loadedSchema => {
      // 1. The relation key must not be a protected field on the owning class.
      const protectedFields = this.addProtectedFields(loadedSchema, owningClassName, {}, aclGroup, auth) || [];
      const rootField = typeof relationKey === 'string' ? relationKey.split('.')[0] : relationKey;
      if (protectedFields.includes(relationKey) || protectedFields.includes(rootField)) {
        throw (0, _Error.createSanitizedError)(_node.Parse.Error.OPERATION_FORBIDDEN, `This user is not allowed to query ${relationKey} on class ${owningClassName}`, this.options);
      }
      // 2. The caller must be able to read the owning object itself. A read with
      //    the caller's auth context applies the owning class CLP, the object
      //    ACL and pointer permissions. Any "not authorized" or "not found"
      //    outcome maps to "cannot read", so the relation returns no results.
      return this.find(owningClassName, {
        objectId: owningId
      }, {
        acl: aclGroup,
        limit: 1,
        keys: ['objectId'],
        op: 'get'
      }, auth, loadedSchema).then(results => Array.isArray(results) && results.length > 0).catch(error => {
        if (error instanceof _node.Parse.Error && (error.code === _node.Parse.Error.OPERATION_FORBIDDEN || error.code === _node.Parse.Error.OBJECT_NOT_FOUND)) {
          return false;
        }
        throw error;
      });
    });
  }
  addInObjectIdsIds(ids = null, query) {
    const idsFromString = typeof query.objectId === 'string' ? [query.objectId] : null;
    const idsFromEq = query.objectId && query.objectId['$eq'] ? [query.objectId['$eq']] : null;
    const idsFromIn = query.objectId && query.objectId['$in'] ? query.objectId['$in'] : null;

    // -disable-next
    const allIds = [idsFromString, idsFromEq, idsFromIn, ids].filter(list => list !== null);
    const totalLength = allIds.reduce((memo, list) => memo + list.length, 0);
    let idsIntersection = [];
    if (totalLength > 125) {
      idsIntersection = _intersect.default.big(allIds);
    } else {
      idsIntersection = (0, _intersect.default)(allIds);
    }

    // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.
    if (!('objectId' in query)) {
      query.objectId = {
        $in: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $in: undefined,
        $eq: query.objectId
      };
    }
    query.objectId['$in'] = idsIntersection;
    return query;
  }
  addNotInObjectIdsIds(ids = [], query) {
    const idsFromNin = query.objectId && query.objectId['$nin'] ? query.objectId['$nin'] : [];
    let allIds = [...idsFromNin, ...ids].filter(list => list !== null);

    // make a set and spread to remove duplicates
    allIds = [...new Set(allIds)];

    // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.
    if (!('objectId' in query)) {
      query.objectId = {
        $nin: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $nin: undefined,
        $eq: query.objectId
      };
    }
    query.objectId['$nin'] = allIds;
    return query;
  }

  // Runs a query on the database.
  // Returns a promise that resolves to a list of items.
  // Options:
  //   skip    number of results to skip.
  //   limit   limit to this number of results.
  //   sort    an object where keys are the fields to sort by.
  //           the value is +1 for ascending, -1 for descending.
  //   count   run a count instead of returning results.
  //   acl     restrict this operation with an ACL for the provided array
  //           of user objectIds and roles. acl: null means no user.
  //           when this field is not present, don't do anything regarding ACLs.
  //  caseInsensitive make string comparisons case insensitive
  // TODO: make userIds not needed here. The db adapter shouldn't know
  // anything about users, ideally. Then, improve the format of the ACL
  // arg to work like the others.
  find(className, query, {
    skip,
    limit,
    acl,
    sort = {},
    count,
    keys,
    op,
    distinct,
    pipeline,
    readPreference,
    hint,
    caseInsensitive = false,
    explain,
    comment,
    rawValues,
    rawFieldNames
  } = {}, auth = {}, validSchemaController) {
    const isMaintenance = auth.isMaintenance;
    const isMaster = acl === undefined || isMaintenance;
    const aclGroup = acl || [];
    op = op || (typeof query.objectId == 'string' && Object.keys(query).length === 1 ? 'get' : 'find');
    // Count operation if counting
    op = count === true ? 'count' : op;
    let classExists = true;
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      //Allow volatile classes if querying with Master (for _PushStatus)
      //TODO: Move volatile classes concept into mongo adapter, postgres adapter shouldn't care
      //that api.parse.com breaks when _PushStatus exists in mongo.
      return schemaController.getOneSchema(className, isMaster).catch(error => {
        // Behavior for non-existent classes is kinda weird on Parse.com. Probably doesn't matter too much.
        // For now, pretend the class exists but has no objects,
        if (error === undefined) {
          classExists = false;
          return {
            fields: {}
          };
        }
        throw error;
      }).then(schema => {
        // Parse.com treats queries on _created_at and _updated_at as if they were queries on createdAt and updatedAt,
        // so duplicate that behavior here. If both are specified, the correct behavior to match Parse.com is to
        // use the one that appears first in the sort list.
        if (sort._created_at) {
          sort.createdAt = sort._created_at;
          delete sort._created_at;
        }
        if (sort._updated_at) {
          sort.updatedAt = sort._updated_at;
          delete sort._updated_at;
        }
        const queryOptions = {
          skip,
          limit,
          sort,
          keys,
          readPreference,
          hint,
          caseInsensitive: this.options.enableCollationCaseComparison ? false : caseInsensitive,
          explain,
          comment
        };
        Object.keys(sort).forEach(fieldName => {
          if (fieldName.match(/^authData\.([a-zA-Z0-9_]+)\.id$/)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Cannot sort by ${fieldName}`);
          }
          const rootFieldName = getRootFieldName(fieldName);
          if (!SchemaController.fieldNameIsValid(rootFieldName, className)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}.`);
          }
          if (!schema.fields[fieldName.split('.')[0]] && fieldName !== 'score') {
            delete sort[fieldName];
          }
        });
        return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, op)).then(() => this.reduceRelationKeys(className, query, queryOptions, auth, aclGroup, isMaster, schemaController)).then(() => this.reduceInRelation(className, query, schemaController)).then(() => {
          let protectedFields;
          if (!isMaster) {
            query = this.addPointerPermissions(schemaController, className, op, query, aclGroup);
            /* Don't use projections to optimize the protectedFields since the protectedFields
              based on pointer-permissions are determined after querying. The filtering can
              overwrite the protected fields. */
            protectedFields = this.addProtectedFields(schemaController, className, query, aclGroup, auth, queryOptions);
          }
          if (!query) {
            if (op === 'get') {
              throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
            } else {
              return [];
            }
          }
          if (!isMaster) {
            if (op === 'update' || op === 'delete') {
              query = addWriteACL(query, aclGroup);
            } else {
              query = addReadACL(query, aclGroup);
            }
          }
          validateQuery(query, isMaster, isMaintenance, false, this.options);
          if (count) {
            if (!classExists) {
              return 0;
            } else {
              return this.adapter.count(className, schema, query, readPreference, undefined, hint, comment);
            }
          } else if (distinct) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.distinct(className, schema, query, distinct);
            }
          } else if (pipeline) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.aggregate(className, schema, pipeline, readPreference, hint, explain, comment, rawValues, rawFieldNames);
            }
          } else if (explain) {
            return this.adapter.find(className, schema, query, queryOptions);
          } else {
            return this.adapter.find(className, schema, query, queryOptions).then(objects => objects.map(object => {
              object = untransformObjectACL(object);
              return filterSensitiveData(isMaster, isMaintenance, aclGroup, auth, op, schemaController, className, protectedFields, object, this.options.protectedFieldsOwnerExempt);
            })).catch(error => {
              if (error instanceof _node.Parse.Error) {
                throw error;
              }
              const detailedMessage = typeof error === 'string' ? error : error?.message || 'An internal server error occurred';
              throw (0, _Error.createSanitizedError)(_node.Parse.Error.INTERNAL_SERVER_ERROR, detailedMessage, this.options, 'An internal server error occurred');
            });
          }
        });
      });
    });
  }
  deleteSchema(className) {
    let schemaController;
    return this.loadSchema({
      clearCache: true
    }).then(s => {
      schemaController = s;
      return schemaController.getOneSchema(className, true);
    }).catch(error => {
      if (error === undefined) {
        return {
          fields: {}
        };
      } else {
        throw error;
      }
    }).then(schema => {
      return this.collectionExists(className).then(() => this.adapter.count(className, {
        fields: {}
      }, null, '', false)).then(count => {
        if (count > 0) {
          throw new _node.Parse.Error(255, `Class ${className} is not empty, contains ${count} objects, cannot drop schema.`);
        }
        return this.adapter.deleteClass(className);
      }).then(wasParseCollection => {
        if (wasParseCollection) {
          const relationFieldNames = Object.keys(schema.fields).filter(fieldName => schema.fields[fieldName].type === 'Relation');
          return Promise.all(relationFieldNames.map(name => this.adapter.deleteClass(joinTableName(className, name)))).then(() => {
            _SchemaCache.default.del(className);
            return schemaController.reloadData();
          });
        } else {
          return Promise.resolve();
        }
      });
    });
  }

  // This helps to create intermediate objects for simpler comparison of
  // key value pairs used in query objects. Each key value pair will represented
  // in a similar way to json
  objectToEntriesStrings(query) {
    return Object.entries(query).map(a => a.map(s => JSON.stringify(s)).join(':'));
  }

  // Naive logic reducer for OR operations meant to be used only for pointer permissions.
  reduceOrOperation(query) {
    if (!query.$or) {
      return query;
    }
    const queries = query.$or.map(q => this.objectToEntriesStrings(q));
    let repeat = false;
    do {
      repeat = false;
      for (let i = 0; i < queries.length - 1; i++) {
        for (let j = i + 1; j < queries.length; j++) {
          const [shorter, longer] = queries[i].length > queries[j].length ? [j, i] : [i, j];
          const foundEntries = queries[shorter].reduce((acc, entry) => acc + (queries[longer].includes(entry) ? 1 : 0), 0);
          const shorterEntries = queries[shorter].length;
          if (foundEntries === shorterEntries) {
            // If the shorter query is completely contained in the longer one, we can strike
            // out the longer query.
            query.$or.splice(longer, 1);
            queries.splice(longer, 1);
            repeat = true;
            break;
          }
        }
      }
    } while (repeat);
    if (query.$or.length === 1) {
      query = {
        ...query,
        ...query.$or[0]
      };
      delete query.$or;
    }
    return query;
  }

  // Naive logic reducer for AND operations meant to be used only for pointer permissions.
  reduceAndOperation(query) {
    if (!query.$and) {
      return query;
    }
    const queries = query.$and.map(q => this.objectToEntriesStrings(q));
    let repeat = false;
    do {
      repeat = false;
      for (let i = 0; i < queries.length - 1; i++) {
        for (let j = i + 1; j < queries.length; j++) {
          const [shorter, longer] = queries[i].length > queries[j].length ? [j, i] : [i, j];
          const foundEntries = queries[shorter].reduce((acc, entry) => acc + (queries[longer].includes(entry) ? 1 : 0), 0);
          const shorterEntries = queries[shorter].length;
          if (foundEntries === shorterEntries) {
            // If the shorter query is completely contained in the longer one, we can strike
            // out the shorter query.
            query.$and.splice(shorter, 1);
            queries.splice(shorter, 1);
            repeat = true;
            break;
          }
        }
      }
    } while (repeat);
    if (query.$and.length === 1) {
      query = {
        ...query,
        ...query.$and[0]
      };
      delete query.$and;
    }
    return query;
  }

  // Constraints query using CLP's pointer permissions (PP) if any.
  // 1. Etract the user id from caller's ACLgroup;
  // 2. Exctract a list of field names that are PP for target collection and operation;
  // 3. Constraint the original query so that each PP field must
  // point to caller's id (or contain it in case of PP field being an array)
  addPointerPermissions(schema, className, operation, query, aclGroup = []) {
    // Check if class has public permission for operation
    // If the BaseCLP pass, let go through
    if (schema.testPermissionsForClassName(className, aclGroup, operation)) {
      return query;
    }
    const perms = schema.getClassLevelPermissions(className);
    const userACL = aclGroup.filter(acl => {
      return acl.indexOf('role:') != 0 && acl != '*';
    });
    const groupKey = ['get', 'find', 'count'].indexOf(operation) > -1 ? 'readUserFields' : 'writeUserFields';
    const permFields = [];
    if (perms[operation] && perms[operation].pointerFields) {
      permFields.push(...perms[operation].pointerFields);
    }
    if (perms[groupKey]) {
      for (const field of perms[groupKey]) {
        if (!permFields.includes(field)) {
          permFields.push(field);
        }
      }
    }
    // the ACL should have exactly 1 user
    if (permFields.length > 0) {
      // the ACL should have exactly 1 user
      // No user set return undefined
      // If the length is > 1, that means we didn't de-dupe users correctly
      if (userACL.length != 1) {
        return;
      }
      const userId = userACL[0];
      const userPointer = {
        __type: 'Pointer',
        className: '_User',
        objectId: userId
      };
      const queries = permFields.map(key => {
        const fieldDescriptor = schema.getExpectedType(className, key);
        const fieldType = fieldDescriptor && typeof fieldDescriptor === 'object' && Object.prototype.hasOwnProperty.call(fieldDescriptor, 'type') ? fieldDescriptor.type : null;
        let queryClause;
        if (fieldType === 'Pointer') {
          // constraint for single pointer setup
          queryClause = {
            [key]: userPointer
          };
        } else if (fieldType === 'Array') {
          // constraint for users-array setup
          queryClause = {
            [key]: {
              $all: [userPointer]
            }
          };
        } else if (fieldType === 'Object') {
          // constraint for object setup
          queryClause = {
            [key]: userPointer
          };
        } else {
          // This means that there is a CLP field of an unexpected type. This condition should not happen, which is
          // why is being treated as an error.
          throw Error(`An unexpected condition occurred when resolving pointer permissions: ${className} ${key}`);
        }
        // if we already have a constraint on the key, use the $and
        if (Object.prototype.hasOwnProperty.call(query, key)) {
          return this.reduceAndOperation({
            $and: [queryClause, query]
          });
        }
        // otherwise just add the constaint
        return Object.assign({}, query, queryClause);
      });
      return queries.length === 1 ? queries[0] : this.reduceOrOperation({
        $or: queries
      });
    } else {
      return query;
    }
  }
  addProtectedFields(schema, className, query = {}, aclGroup = [], auth = {}, queryOptions = {}) {
    const perms = schema && schema.getClassLevelPermissions ? schema.getClassLevelPermissions(className) : schema;
    if (!perms) {
      return null;
    }
    const protectedFields = perms.protectedFields;
    if (!protectedFields) {
      return null;
    }
    if (className === '_User' && this.options.protectedFieldsOwnerExempt !== false && aclGroup.indexOf(query.objectId) > -1) {
      return null;
    }

    // for queries where "keys" are set and do not include all 'userField':{field},
    // we have to transparently include it, and then remove before returning to client
    // Because if such key not projected the permission won't be enforced properly
    // PS this is called when 'excludeKeys' already reduced to 'keys'
    const preserveKeys = queryOptions.keys;

    // these are keys that need to be included only
    // to be able to apply protectedFields by pointer
    // and then unset before returning to client (later in  filterSensitiveFields)
    const serverOnlyKeys = [];
    const authenticated = auth.user;

    // map to allow check without array search
    const roles = (auth.userRoles || []).reduce((acc, r) => {
      acc[r] = protectedFields[r];
      return acc;
    }, {});

    // array of sets of protected fields. separate item for each applicable criteria
    const protectedKeysSets = [];
    for (const key in protectedFields) {
      // skip userFields
      if (key.startsWith('userField:')) {
        if (preserveKeys) {
          const fieldName = key.substring(10);
          if (!preserveKeys.includes(fieldName)) {
            // 1. put it there temporarily
            queryOptions.keys && queryOptions.keys.push(fieldName);
            // 2. preserve it delete later
            serverOnlyKeys.push(fieldName);
          }
        }
        continue;
      }

      // add public tier
      if (key === '*') {
        protectedKeysSets.push(protectedFields[key]);
        continue;
      }
      if (authenticated) {
        if (key === 'authenticated') {
          // for logged in users
          protectedKeysSets.push(protectedFields[key]);
          continue;
        }
        if (roles[key] && key.startsWith('role:')) {
          // add applicable roles
          protectedKeysSets.push(roles[key]);
        }
      }
    }

    // check if there's a rule for current user's id
    if (authenticated) {
      const userId = auth.user.id;
      if (perms.protectedFields[userId]) {
        protectedKeysSets.push(perms.protectedFields[userId]);
      }
    }

    // preserve fields to be removed before sending response to client
    if (serverOnlyKeys.length > 0) {
      perms.protectedFields.temporaryKeys = serverOnlyKeys;
    }
    let protectedKeys = protectedKeysSets.reduce((acc, next) => {
      if (next) {
        acc.push(...next);
      }
      return acc;
    }, []);

    // intersect all sets of protectedFields
    protectedKeysSets.forEach(fields => {
      if (fields) {
        protectedKeys = protectedKeys.filter(v => fields.includes(v));
      }
    });
    return protectedKeys;
  }
  createTransactionalSession() {
    return this.adapter.createTransactionalSession().then(transactionalSession => {
      this._transactionalSession = transactionalSession;
    });
  }
  commitTransactionalSession() {
    if (!this._transactionalSession) {
      throw new Error('There is no transactional session to commit');
    }
    return this.adapter.commitTransactionalSession(this._transactionalSession).then(() => {
      this._transactionalSession = null;
    });
  }
  abortTransactionalSession() {
    if (!this._transactionalSession) {
      throw new Error('There is no transactional session to abort');
    }
    return this.adapter.abortTransactionalSession(this._transactionalSession).then(() => {
      this._transactionalSession = null;
    });
  }

  // TODO: create indexes on first creation of a _User object. Otherwise it's impossible to
  // have a Parse app without it having a _User collection.
  async performInitialization() {
    await this.adapter.performInitialization({
      VolatileClassesSchemas: SchemaController.VolatileClassesSchemas
    });
    const requiredUserFields = {
      fields: {
        ...SchemaController.defaultColumns._Default,
        ...SchemaController.defaultColumns._User
      }
    };
    const requiredRoleFields = {
      fields: {
        ...SchemaController.defaultColumns._Default,
        ...SchemaController.defaultColumns._Role
      }
    };
    const requiredIdempotencyFields = {
      fields: {
        ...SchemaController.defaultColumns._Default,
        ...SchemaController.defaultColumns._Idempotency
      }
    };
    await this.loadSchema().then(schema => schema.enforceClassExists('_User'));
    await this.loadSchema().then(schema => schema.enforceClassExists('_Role'));
    await this.loadSchema().then(schema => schema.enforceClassExists('_Idempotency'));
    const databaseOptions = this.options.databaseOptions || {};
    if (databaseOptions.createIndexUserUsername !== false) {
      await this.adapter.ensureUniqueness('_User', requiredUserFields, ['username']).catch(error => {
        _logger.default.warn('Unable to ensure uniqueness for usernames: ', error);
        throw error;
      });
    }
    if (!this.options.enableCollationCaseComparison) {
      if (databaseOptions.createIndexUserUsernameCaseInsensitive !== false) {
        await this.adapter.ensureIndex('_User', requiredUserFields, ['username'], 'case_insensitive_username', true).catch(error => {
          _logger.default.warn('Unable to create case insensitive username index: ', error);
          throw error;
        });
      }
      if (databaseOptions.createIndexUserEmailCaseInsensitive !== false) {
        await this.adapter.ensureIndex('_User', requiredUserFields, ['email'], 'case_insensitive_email', true).catch(error => {
          _logger.default.warn('Unable to create case insensitive email index: ', error);
          throw error;
        });
      }
    }
    if (databaseOptions.createIndexUserEmail !== false) {
      await this.adapter.ensureUniqueness('_User', requiredUserFields, ['email']).catch(error => {
        _logger.default.warn('Unable to ensure uniqueness for user email addresses: ', error);
        throw error;
      });
    }
    if (databaseOptions.createIndexUserEmailVerifyToken !== false) {
      await this.adapter.ensureIndex('_User', requiredUserFields, ['_email_verify_token'], '_email_verify_token', false).catch(error => {
        _logger.default.warn('Unable to create index for email verification token: ', error);
        throw error;
      });
    }
    if (databaseOptions.createIndexUserPasswordResetToken !== false) {
      await this.adapter.ensureIndex('_User', requiredUserFields, ['_perishable_token'], '_perishable_token', false).catch(error => {
        _logger.default.warn('Unable to create index for password reset token: ', error);
        throw error;
      });
    }
    if (databaseOptions.createIndexRoleName !== false) {
      await this.adapter.ensureUniqueness('_Role', requiredRoleFields, ['name']).catch(error => {
        _logger.default.warn('Unable to ensure uniqueness for role name: ', error);
        throw error;
      });
    }
    await this.adapter.ensureUniqueness('_Idempotency', requiredIdempotencyFields, ['reqId']).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for idempotency request ID: ', error);
      throw error;
    });
    const isMongoAdapter = this.adapter instanceof _MongoStorageAdapter.default;
    const isPostgresAdapter = this.adapter instanceof _PostgresStorageAdapter.default;
    if (isMongoAdapter || isPostgresAdapter) {
      let options = {};
      if (isMongoAdapter) {
        options = {
          ttl: 0
        };
      } else if (isPostgresAdapter) {
        options = this.idempotencyOptions;
        options.setIdempotencyFunction = true;
      }
      await this.adapter.ensureIndex('_Idempotency', requiredIdempotencyFields, ['expire'], 'ttl', false, options).catch(error => {
        _logger.default.warn('Unable to create TTL index for idempotency expire date: ', error);
        throw error;
      });
    }
    // Create unique indexes for authData providers to prevent race conditions
    // during concurrent signups with the same authData
    if (databaseOptions.createIndexAuthDataUniqueness !== false && typeof this.adapter.ensureAuthDataUniqueness === 'function') {
      const authProviders = Object.keys(this.options.auth || {});
      if (this.options.enableAnonymousUsers !== false) {
        if (!authProviders.includes('anonymous')) {
          authProviders.push('anonymous');
        }
      }
      await Promise.all(authProviders.map(provider => this.adapter.ensureAuthDataUniqueness(provider).catch(error => {
        _logger.default.warn(`Unable to ensure uniqueness for auth data provider "${provider}": `, error);
      })));
    }
    await this.adapter.updateSchemaWithIndexes();
  }
  _expandResultOnKeyPath(object, key, value) {
    if (key.indexOf('.') < 0) {
      object[key] = value[key];
      return object;
    }
    const path = key.split('.');
    const firstKey = path[0];
    const nextPath = path.slice(1).join('.');

    // Scan request data for denied keywords
    if (this.options && this.options.requestKeywordDenylist) {
      // Scan request data for denied keywords
      for (const keyword of this.options.requestKeywordDenylist) {
        const match = _Utils.default.objectContainsKeyValue({
          [firstKey]: true,
          [nextPath]: true
        }, keyword.key, true);
        if (match) {
          throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Prohibited keyword in request data: ${JSON.stringify(keyword)}.`);
        }
      }
    }
    object[firstKey] = this._expandResultOnKeyPath(object[firstKey] || {}, nextPath, value[firstKey]);
    delete object[key];
    return object;
  }
  _sanitizeDatabaseResult(originalObject, result) {
    const response = {};
    if (!result) {
      return Promise.resolve(response);
    }
    Object.keys(originalObject).forEach(key => {
      const keyUpdate = originalObject[key];
      // determine if that was an op
      if (keyUpdate && typeof keyUpdate === 'object' && keyUpdate.__op && ['Add', 'AddUnique', 'Remove', 'Increment', 'SetOnInsert'].indexOf(keyUpdate.__op) > -1) {
        // only valid ops that produce an actionable result
        // the op may have happened on a keypath
        this._expandResultOnKeyPath(response, key, result);
        // Revert array to object conversion on dot notation for arrays (e.g. "field.0.key")
        if (key.includes('.')) {
          const [field, index] = key.split('.');
          const isArrayIndex = Array.from(index).every(c => c >= '0' && c <= '9');
          if (isArrayIndex && Array.isArray(result[field]) && !Array.isArray(response[field])) {
            response[field] = result[field];
          }
        }
      }
    });
    return Promise.resolve(response);
  }
}
module.exports = DatabaseController;
// Expose validateQuery for tests
module.exports._validateQuery = validateQuery;
module.exports.filterSensitiveData = filterSensitiveData;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsInJlcXVpcmUiLCJfbG9kYXNoIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsIl9pbnRlcnNlY3QiLCJfbG9nZ2VyIiwiX1V0aWxzIiwiU2NoZW1hQ29udHJvbGxlciIsIl9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkIiwiX1N0b3JhZ2VBZGFwdGVyIiwiX01vbmdvU3RvcmFnZUFkYXB0ZXIiLCJfUG9zdGdyZXNTdG9yYWdlQWRhcHRlciIsIl9TY2hlbWFDYWNoZSIsIl9FcnJvciIsImUiLCJ0IiwiV2Vha01hcCIsInIiLCJuIiwiX19lc01vZHVsZSIsIm8iLCJpIiwiZiIsIl9fcHJvdG9fXyIsImRlZmF1bHQiLCJoYXMiLCJnZXQiLCJzZXQiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJPYmplY3QiLCJkZWZpbmVQcm9wZXJ0eSIsImdldE93blByb3BlcnR5RGVzY3JpcHRvciIsInF1ZXJ5T3BlcmF0b3JzIiwiaW50ZXJuYWxGaWVsZHMiLCJfcnBlcm0iLCJjbGllbnRSZWFkIiwibWFzdGVyUmVhZCIsIm1hc3RlcldyaXRlIiwiX3dwZXJtIiwiX2hhc2hlZF9wYXNzd29yZCIsIl9lbWFpbF92ZXJpZnlfdG9rZW4iLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQiLCJfZmFpbGVkX2xvZ2luX2NvdW50IiwiX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0IiwiX3Bhc3N3b3JkX2NoYW5nZWRfYXQiLCJfcGFzc3dvcmRfaGlzdG9yeSIsIl90b21ic3RvbmUiLCJfc2Vzc2lvbl90b2tlbiIsInNwZWNpYWxRdWVyeUtleXMiLCJrZXlzIiwiZmlsdGVyIiwiayIsInNwZWNpYWxNYXN0ZXJRdWVyeUtleXMiLCJhZGRXcml0ZUFDTCIsInF1ZXJ5IiwiYWNsIiwibmV3UXVlcnkiLCJfIiwiY2xvbmVEZWVwIiwiJGluIiwiYWRkUmVhZEFDTCIsInRyYW5zZm9ybU9iamVjdEFDTCIsIkFDTCIsInJlc3VsdCIsImVudHJ5IiwicmVhZCIsInB1c2giLCJ3cml0ZSIsInZhbGlkYXRlUXVlcnkiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJ1cGRhdGUiLCJvcHRpb25zIiwiX2RlcHRoIiwicmMiLCJyZXF1ZXN0Q29tcGxleGl0eSIsInF1ZXJ5RGVwdGgiLCJQYXJzZSIsIkVycm9yIiwiSU5WQUxJRF9RVUVSWSIsIiRvciIsIkFycmF5IiwiaXNBcnJheSIsImZvckVhY2giLCJ2YWx1ZSIsIiRhbmQiLCIkbm9yIiwibGVuZ3RoIiwia2V5IiwiJHJlZ2V4IiwidW5kZWZpbmVkIiwiYWxsb3dSZWdleCIsIiRvcHRpb25zIiwibWF0Y2giLCJpbmNsdWRlcyIsIklOVkFMSURfS0VZX05BTUUiLCJmaWx0ZXJTZW5zaXRpdmVEYXRhIiwiYWNsR3JvdXAiLCJhdXRoIiwib3BlcmF0aW9uIiwic2NoZW1hIiwiY2xhc3NOYW1lIiwicHJvdGVjdGVkRmllbGRzIiwib2JqZWN0IiwicHJvdGVjdGVkRmllbGRzT3duZXJFeGVtcHQiLCJ1c2VySWQiLCJ1c2VyIiwiaWQiLCJwZXJtcyIsImdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImlzUmVhZE9wZXJhdGlvbiIsImluZGV4T2YiLCJwcm90ZWN0ZWRGaWVsZHNQb2ludGVyUGVybSIsInN0YXJ0c1dpdGgiLCJtYXAiLCJzdWJzdHJpbmciLCJuZXdQcm90ZWN0ZWRGaWVsZHMiLCJvdmVycmlkZVByb3RlY3RlZEZpZWxkcyIsInBvaW50ZXJQZXJtIiwicG9pbnRlclBlcm1JbmNsdWRlc1VzZXIiLCJyZWFkVXNlckZpZWxkVmFsdWUiLCJzb21lIiwib2JqZWN0SWQiLCJmaWVsZHMiLCJ2IiwiaXNVc2VyQ2xhc3MiLCJwYXNzd29yZCIsInNlc3Npb25Ub2tlbiIsImlzT3duZXJFeGVtcHQiLCJ0ZW1wb3JhcnlLZXlzIiwiY2hhckF0IiwiYXV0aERhdGEiLCJzcGVjaWFsS2V5c0ZvclVwZGF0ZSIsImlzU3BlY2lhbFVwZGF0ZUtleSIsImpvaW5UYWJsZU5hbWUiLCJmbGF0dGVuVXBkYXRlT3BlcmF0b3JzRm9yQ3JlYXRlIiwiX19vcCIsImFtb3VudCIsIklOVkFMSURfSlNPTiIsIm9iamVjdHMiLCJDT01NQU5EX1VOQVZBSUxBQkxFIiwidHJhbnNmb3JtQXV0aERhdGEiLCJwcm92aWRlciIsInByb3ZpZGVyRGF0YSIsImZpZWxkTmFtZSIsInR5cGUiLCJ1bnRyYW5zZm9ybU9iamVjdEFDTCIsIm91dHB1dCIsImdldFJvb3RGaWVsZE5hbWUiLCJzcGxpdCIsInJlbGF0aW9uU2NoZW1hIiwicmVsYXRlZElkIiwib3duaW5nSWQiLCJjb252ZXJ0RW1haWxUb0xvd2VyY2FzZSIsInRvTG93ZXJDYXNlIiwiY29udmVydFVzZXJuYW1lVG9Mb3dlcmNhc2UiLCJEYXRhYmFzZUNvbnRyb2xsZXIiLCJjb25zdHJ1Y3RvciIsImFkYXB0ZXIiLCJpZGVtcG90ZW5jeU9wdGlvbnMiLCJzY2hlbWFQcm9taXNlIiwiX3RyYW5zYWN0aW9uYWxTZXNzaW9uIiwiY29sbGVjdGlvbkV4aXN0cyIsImNsYXNzRXhpc3RzIiwicHVyZ2VDb2xsZWN0aW9uIiwibG9hZFNjaGVtYSIsInRoZW4iLCJzY2hlbWFDb250cm9sbGVyIiwiZ2V0T25lU2NoZW1hIiwiZGVsZXRlT2JqZWN0c0J5UXVlcnkiLCJ2YWxpZGF0ZUNsYXNzTmFtZSIsImNsYXNzTmFtZUlzVmFsaWQiLCJQcm9taXNlIiwicmVqZWN0IiwiSU5WQUxJRF9DTEFTU19OQU1FIiwicmVzb2x2ZSIsImNsZWFyQ2FjaGUiLCJsb2FkIiwibG9hZFNjaGVtYUlmTmVlZGVkIiwicmVkaXJlY3RDbGFzc05hbWVGb3JLZXkiLCJnZXRFeHBlY3RlZFR5cGUiLCJ0YXJnZXRDbGFzcyIsInZhbGlkYXRlT2JqZWN0IiwicnVuT3B0aW9ucyIsIm1haW50ZW5hbmNlIiwicyIsImNhbkFkZEZpZWxkIiwibWFueSIsInVwc2VydCIsImFkZHNGaWVsZCIsInNraXBTYW5pdGl6YXRpb24iLCJ2YWxpZGF0ZU9ubHkiLCJ2YWxpZFNjaGVtYUNvbnRyb2xsZXIiLCJVdGlscyIsImNoZWNrUHJvaGliaXRlZEtleXdvcmRzIiwiZXJyb3IiLCJ2YWxpZGF0ZUZpbGVVcmxzSW5PYmplY3QiLCJGSUxFX1NBVkVfRVJST1IiLCJtZXNzYWdlIiwib3JpZ2luYWxRdWVyeSIsIm9yaWdpbmFsVXBkYXRlIiwic3RydWN0dXJlZENsb25lIiwicmVsYXRpb25VcGRhdGVzIiwidmFsaWRhdGVQZXJtaXNzaW9uIiwiY29sbGVjdFJlbGF0aW9uVXBkYXRlcyIsImFkZFBvaW50ZXJQZXJtaXNzaW9ucyIsImNhdGNoIiwicm9vdEZpZWxkTmFtZSIsImZpZWxkTmFtZUlzVmFsaWQiLCJ1cGRhdGVPcGVyYXRpb24iLCJpbm5lcktleSIsIklOVkFMSURfTkVTVEVEX0tFWSIsImZpbmQiLCJyZWFkUHJlZmVyZW5jZSIsIk9CSkVDVF9OT1RfRk9VTkQiLCJ1cGRhdGVPYmplY3RzQnlRdWVyeSIsInVwc2VydE9uZU9iamVjdCIsImZpbmRPbmVBbmRVcGRhdGUiLCJoYW5kbGVSZWxhdGlvblVwZGF0ZXMiLCJtYXRjaGVkQ291bnQiLCJtb2RpZmllZENvdW50IiwiX3Nhbml0aXplRGF0YWJhc2VSZXN1bHQiLCJvcHMiLCJkZWxldGVNZSIsInByb2Nlc3MiLCJvcCIsIngiLCJwZW5kaW5nIiwiYWRkUmVsYXRpb24iLCJyZW1vdmVSZWxhdGlvbiIsImFsbCIsImZyb21DbGFzc05hbWUiLCJmcm9tSWQiLCJ0b0lkIiwiZG9jIiwiY29kZSIsImRlc3Ryb3kiLCJwYXJzZUZvcm1hdFNjaGVtYSIsImNyZWF0ZSIsIm9yaWdpbmFsT2JqZWN0IiwiY3JlYXRlZEF0IiwiaXNvIiwiX190eXBlIiwidXBkYXRlZEF0IiwiZW5mb3JjZUNsYXNzRXhpc3RzIiwiY3JlYXRlT2JqZWN0IiwiY29udmVydFNjaGVtYVRvQWRhcHRlclNjaGVtYSIsImNsYXNzU2NoZW1hIiwic2NoZW1hRGF0YSIsInNjaGVtYUZpZWxkcyIsIm5ld0tleXMiLCJmaWVsZCIsImFjdGlvbiIsImRlbGV0ZUV2ZXJ5dGhpbmciLCJmYXN0IiwiU2NoZW1hQ2FjaGUiLCJjbGVhciIsImRlbGV0ZUFsbENsYXNzZXMiLCJyZWxhdGVkSWRzIiwicXVlcnlPcHRpb25zIiwic2tpcCIsImxpbWl0Iiwic29ydCIsImZpbmRPcHRpb25zIiwiY2FuU29ydE9uSm9pblRhYmxlcyIsIl9pZCIsInJlc3VsdHMiLCJvd25pbmdJZHMiLCJyZWR1Y2VJblJlbGF0aW9uIiwicHJvbWlzZXMiLCJvcnMiLCJhUXVlcnkiLCJpbmRleCIsImFuZHMiLCJvdGhlcktleXMiLCJxdWVyaWVzIiwiY29uc3RyYWludEtleSIsImlzTmVnYXRpb24iLCJxIiwiaWRzIiwiYWRkTm90SW5PYmplY3RJZHNJZHMiLCJhZGRJbk9iamVjdElkc0lkcyIsInJlZHVjZVJlbGF0aW9uS2V5cyIsInJlbGF0ZWRUbyIsImF1dGhvcml6ZVJlbGF0ZWRUb1F1ZXJ5IiwiY2FuUmVhZE93bmluZ09iamVjdCIsIm93bmluZ0NsYXNzTmFtZSIsInJlbGF0aW9uS2V5IiwibG9hZGVkU2NoZW1hIiwiYWRkUHJvdGVjdGVkRmllbGRzIiwicm9vdEZpZWxkIiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwiaWRzRnJvbVN0cmluZyIsImlkc0Zyb21FcSIsImlkc0Zyb21JbiIsImFsbElkcyIsImxpc3QiLCJ0b3RhbExlbmd0aCIsInJlZHVjZSIsIm1lbW8iLCJpZHNJbnRlcnNlY3Rpb24iLCJpbnRlcnNlY3QiLCJiaWciLCIkZXEiLCJpZHNGcm9tTmluIiwiU2V0IiwiJG5pbiIsImNvdW50IiwiZGlzdGluY3QiLCJwaXBlbGluZSIsImhpbnQiLCJjYXNlSW5zZW5zaXRpdmUiLCJleHBsYWluIiwiY29tbWVudCIsInJhd1ZhbHVlcyIsInJhd0ZpZWxkTmFtZXMiLCJfY3JlYXRlZF9hdCIsIl91cGRhdGVkX2F0IiwiZW5hYmxlQ29sbGF0aW9uQ2FzZUNvbXBhcmlzb24iLCJhZ2dyZWdhdGUiLCJkZXRhaWxlZE1lc3NhZ2UiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJkZWxldGVTY2hlbWEiLCJkZWxldGVDbGFzcyIsIndhc1BhcnNlQ29sbGVjdGlvbiIsInJlbGF0aW9uRmllbGROYW1lcyIsIm5hbWUiLCJkZWwiLCJyZWxvYWREYXRhIiwib2JqZWN0VG9FbnRyaWVzU3RyaW5ncyIsImVudHJpZXMiLCJhIiwiSlNPTiIsInN0cmluZ2lmeSIsImpvaW4iLCJyZWR1Y2VPck9wZXJhdGlvbiIsInJlcGVhdCIsImoiLCJzaG9ydGVyIiwibG9uZ2VyIiwiZm91bmRFbnRyaWVzIiwiYWNjIiwic2hvcnRlckVudHJpZXMiLCJzcGxpY2UiLCJyZWR1Y2VBbmRPcGVyYXRpb24iLCJ0ZXN0UGVybWlzc2lvbnNGb3JDbGFzc05hbWUiLCJ1c2VyQUNMIiwiZ3JvdXBLZXkiLCJwZXJtRmllbGRzIiwicG9pbnRlckZpZWxkcyIsInVzZXJQb2ludGVyIiwiZmllbGREZXNjcmlwdG9yIiwiZmllbGRUeXBlIiwicHJvdG90eXBlIiwicXVlcnlDbGF1c2UiLCIkYWxsIiwiYXNzaWduIiwicHJlc2VydmVLZXlzIiwic2VydmVyT25seUtleXMiLCJhdXRoZW50aWNhdGVkIiwicm9sZXMiLCJ1c2VyUm9sZXMiLCJwcm90ZWN0ZWRLZXlzU2V0cyIsInByb3RlY3RlZEtleXMiLCJuZXh0IiwiY3JlYXRlVHJhbnNhY3Rpb25hbFNlc3Npb24iLCJ0cmFuc2FjdGlvbmFsU2Vzc2lvbiIsImNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbiIsInBlcmZvcm1Jbml0aWFsaXphdGlvbiIsIlZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMiLCJyZXF1aXJlZFVzZXJGaWVsZHMiLCJkZWZhdWx0Q29sdW1ucyIsIl9EZWZhdWx0IiwiX1VzZXIiLCJyZXF1aXJlZFJvbGVGaWVsZHMiLCJfUm9sZSIsInJlcXVpcmVkSWRlbXBvdGVuY3lGaWVsZHMiLCJfSWRlbXBvdGVuY3kiLCJkYXRhYmFzZU9wdGlvbnMiLCJjcmVhdGVJbmRleFVzZXJVc2VybmFtZSIsImVuc3VyZVVuaXF1ZW5lc3MiLCJsb2dnZXIiLCJ3YXJuIiwiY3JlYXRlSW5kZXhVc2VyVXNlcm5hbWVDYXNlSW5zZW5zaXRpdmUiLCJlbnN1cmVJbmRleCIsImNyZWF0ZUluZGV4VXNlckVtYWlsQ2FzZUluc2Vuc2l0aXZlIiwiY3JlYXRlSW5kZXhVc2VyRW1haWwiLCJjcmVhdGVJbmRleFVzZXJFbWFpbFZlcmlmeVRva2VuIiwiY3JlYXRlSW5kZXhVc2VyUGFzc3dvcmRSZXNldFRva2VuIiwiY3JlYXRlSW5kZXhSb2xlTmFtZSIsImlzTW9uZ29BZGFwdGVyIiwiTW9uZ29TdG9yYWdlQWRhcHRlciIsImlzUG9zdGdyZXNBZGFwdGVyIiwiUG9zdGdyZXNTdG9yYWdlQWRhcHRlciIsInR0bCIsInNldElkZW1wb3RlbmN5RnVuY3Rpb24iLCJjcmVhdGVJbmRleEF1dGhEYXRhVW5pcXVlbmVzcyIsImVuc3VyZUF1dGhEYXRhVW5pcXVlbmVzcyIsImF1dGhQcm92aWRlcnMiLCJlbmFibGVBbm9ueW1vdXNVc2VycyIsInVwZGF0ZVNjaGVtYVdpdGhJbmRleGVzIiwiX2V4cGFuZFJlc3VsdE9uS2V5UGF0aCIsInBhdGgiLCJmaXJzdEtleSIsIm5leHRQYXRoIiwic2xpY2UiLCJyZXF1ZXN0S2V5d29yZERlbnlsaXN0Iiwia2V5d29yZCIsIm9iamVjdENvbnRhaW5zS2V5VmFsdWUiLCJyZXNwb25zZSIsImtleVVwZGF0ZSIsImlzQXJyYXlJbmRleCIsImZyb20iLCJldmVyeSIsImMiLCJtb2R1bGUiLCJleHBvcnRzIiwiX3ZhbGlkYXRlUXVlcnkiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvQ29udHJvbGxlcnMvRGF0YWJhc2VDb250cm9sbGVyLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIu+7vy8vIEBmbG93XG4vLyBBIGRhdGFiYXNlIGFkYXB0ZXIgdGhhdCB3b3JrcyB3aXRoIGRhdGEgZXhwb3J0ZWQgZnJvbSB0aGUgaG9zdGVkXG4vLyBQYXJzZSBkYXRhYmFzZS5cblxuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgeyBQYXJzZSB9IGZyb20gJ3BhcnNlL25vZGUnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgaW50ZXJzZWN0IGZyb20gJ2ludGVyc2VjdCc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4uL2xvZ2dlcic7XG5pbXBvcnQgVXRpbHMgZnJvbSAnLi4vVXRpbHMnO1xuaW1wb3J0ICogYXMgU2NoZW1hQ29udHJvbGxlciBmcm9tICcuL1NjaGVtYUNvbnRyb2xsZXInO1xuaW1wb3J0IHsgU3RvcmFnZUFkYXB0ZXIgfSBmcm9tICcuLi9BZGFwdGVycy9TdG9yYWdlL1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCBNb25nb1N0b3JhZ2VBZGFwdGVyIGZyb20gJy4uL0FkYXB0ZXJzL1N0b3JhZ2UvTW9uZ28vTW9uZ29TdG9yYWdlQWRhcHRlcic7XG5pbXBvcnQgUG9zdGdyZXNTdG9yYWdlQWRhcHRlciBmcm9tICcuLi9BZGFwdGVycy9TdG9yYWdlL1Bvc3RncmVzL1Bvc3RncmVzU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IFNjaGVtYUNhY2hlIGZyb20gJy4uL0FkYXB0ZXJzL0NhY2hlL1NjaGVtYUNhY2hlJztcbmltcG9ydCB0eXBlIHsgTG9hZFNjaGVtYU9wdGlvbnMgfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB0eXBlIHsgUGFyc2VTZXJ2ZXJPcHRpb25zIH0gZnJvbSAnLi4vT3B0aW9ucyc7XG5pbXBvcnQgdHlwZSB7IFF1ZXJ5T3B0aW9ucywgRnVsbFF1ZXJ5T3B0aW9ucyB9IGZyb20gJy4uL0FkYXB0ZXJzL1N0b3JhZ2UvU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHsgY3JlYXRlU2FuaXRpemVkRXJyb3IgfSBmcm9tICcuLi9FcnJvcic7XG5cbi8vIFF1ZXJ5IG9wZXJhdG9ycyB0aGF0IGFsd2F5cyBwYXNzIHZhbGlkYXRpb24gcmVnYXJkbGVzcyBvZiBhdXRoIGxldmVsLlxuY29uc3QgcXVlcnlPcGVyYXRvcnMgPSBbJyRhbmQnLCAnJG9yJywgJyRub3InXTtcblxuLy8gUmVnaXN0cnkgb2YgaW50ZXJuYWwgZmllbGRzIHdpdGggYWNjZXNzIHBlcm1pc3Npb25zLlxuLy8gSW50ZXJuYWwgZmllbGRzIGFyZSBuZXZlciBkaXJlY3RseSB3cml0YWJsZSBieSBjbGllbnRzLCBzbyBjbGllbnRXcml0ZSBpcyBvbWl0dGVkLlxuLy8gLSBjbGllbnRSZWFkOiBhbnkgY2xpZW50IGNhbiB1c2UgdGhpcyBmaWVsZCBpbiBxdWVyaWVzXG4vLyAtIG1hc3RlclJlYWQ6IG1hc3RlciBrZXkgY2FuIHVzZSB0aGlzIGZpZWxkIGluIHF1ZXJpZXNcbi8vIC0gbWFzdGVyV3JpdGU6IG1hc3RlciBrZXkgY2FuIHVzZSB0aGlzIGZpZWxkIGluIHVwZGF0ZXNcbmNvbnN0IGludGVybmFsRmllbGRzID0ge1xuICBfcnBlcm06ICAgICAgICAgICAgICAgICAgICAgICAgIHsgY2xpZW50UmVhZDogdHJ1ZSwgIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogdHJ1ZSAgfSxcbiAgX3dwZXJtOiAgICAgICAgICAgICAgICAgICAgICAgICB7IGNsaWVudFJlYWQ6IHRydWUsICBtYXN0ZXJSZWFkOiB0cnVlLCAgbWFzdGVyV3JpdGU6IHRydWUgIH0sXG4gIF9oYXNoZWRfcGFzc3dvcmQ6ICAgICAgICAgICAgICAgeyBjbGllbnRSZWFkOiBmYWxzZSwgbWFzdGVyUmVhZDogZmFsc2UsIG1hc3RlcldyaXRlOiB0cnVlICB9LFxuICBfZW1haWxfdmVyaWZ5X3Rva2VuOiAgICAgICAgICAgIHsgY2xpZW50UmVhZDogZmFsc2UsIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogdHJ1ZSAgfSxcbiAgX3BlcmlzaGFibGVfdG9rZW46ICAgICAgICAgICAgICB7IGNsaWVudFJlYWQ6IGZhbHNlLCBtYXN0ZXJSZWFkOiB0cnVlLCAgbWFzdGVyV3JpdGU6IHRydWUgIH0sXG4gIF9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQ6ICAgeyBjbGllbnRSZWFkOiBmYWxzZSwgbWFzdGVyUmVhZDogdHJ1ZSwgIG1hc3RlcldyaXRlOiB0cnVlICB9LFxuICBfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQ6IHsgY2xpZW50UmVhZDogZmFsc2UsIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogdHJ1ZSAgfSxcbiAgX2ZhaWxlZF9sb2dpbl9jb3VudDogICAgICAgICAgICB7IGNsaWVudFJlYWQ6IGZhbHNlLCBtYXN0ZXJSZWFkOiB0cnVlLCAgbWFzdGVyV3JpdGU6IHRydWUgIH0sXG4gIF9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdDogICAgeyBjbGllbnRSZWFkOiBmYWxzZSwgbWFzdGVyUmVhZDogdHJ1ZSwgIG1hc3RlcldyaXRlOiB0cnVlICB9LFxuICBfcGFzc3dvcmRfY2hhbmdlZF9hdDogICAgICAgICAgIHsgY2xpZW50UmVhZDogZmFsc2UsIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogdHJ1ZSAgfSxcbiAgX3Bhc3N3b3JkX2hpc3Rvcnk6ICAgICAgICAgICAgICB7IGNsaWVudFJlYWQ6IGZhbHNlLCBtYXN0ZXJSZWFkOiB0cnVlLCAgbWFzdGVyV3JpdGU6IHRydWUgIH0sXG4gIF90b21ic3RvbmU6ICAgICAgICAgICAgICAgICAgICAgeyBjbGllbnRSZWFkOiBmYWxzZSwgbWFzdGVyUmVhZDogdHJ1ZSwgIG1hc3RlcldyaXRlOiBmYWxzZSB9LFxuICBfc2Vzc2lvbl90b2tlbjogICAgICAgICAgICAgICAgIHsgY2xpZW50UmVhZDogZmFsc2UsIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogZmFsc2UgfSxcbiAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gIC8vIFRoZSBmb2xsb3dpbmcgZmllbGRzIGFyZSBub3QgYWNjZXNzZWQgYnkgdGhlaXIgXy1wcmVmaXhlZCBuYW1lIHRocm91Z2ggdGhlIEFQSTtcbiAgLy8gdGhleSBhcmUgbWFwcGVkIHRvIFJFU1QtbGV2ZWwgbmFtZXMgaW4gdGhlIGFkYXB0ZXIgbGF5ZXIgb3IgaGFuZGxlZCB0aHJvdWdoXG4gIC8vIHNlcGFyYXRlIGNvZGUgcGF0aHMuXG4gIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAvLyBTeXN0ZW0gZmllbGRzIChtYXBwZWQgdG8gUkVTVC1sZXZlbCBuYW1lcyk6XG4gIC8vIF9pZCAob2JqZWN0SWQpXG4gIC8vIF9jcmVhdGVkX2F0IChjcmVhdGVkQXQpXG4gIC8vIF91cGRhdGVkX2F0ICh1cGRhdGVkQXQpXG4gIC8vIF9sYXN0X3VzZWQgKGxhc3RVc2VkKVxuICAvLyBfZXhwaXJlc0F0IChleHBpcmVzQXQpXG4gIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAvLyBMZWdhY3kgQUNMIGZvcm1hdDogbWFwcGVkIHRvL2Zyb20gX3JwZXJtL193cGVybVxuICAvLyBfYWNsXG4gIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAvLyBTY2hlbWEgbWV0YWRhdGE6IG5vdCBkYXRhIGZpZWxkcywgdXNlZCBvbmx5IGZvciBzY2hlbWEgY29uZmlndXJhdGlvblxuICAvLyBfbWV0YWRhdGFcbiAgLy8gX2NsaWVudF9wZXJtaXNzaW9uc1xuICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgLy8gRHluYW1pYyBhdXRoIGRhdGEgZmllbGRzOiB1c2VkIG9ubHkgaW4gcHJvamVjdGlvbnMgYW5kIHVwZGF0ZXMsIG5vdCBpbiBxdWVyaWVzXG4gIC8vIF9hdXRoX2RhdGFfPHByb3ZpZGVyPlxufTtcblxuLy8gRGVyaXZlZCBhY2Nlc3MgbGlzdHNcbmNvbnN0IHNwZWNpYWxRdWVyeUtleXMgPSBbXG4gIC4uLnF1ZXJ5T3BlcmF0b3JzLFxuICAuLi5PYmplY3Qua2V5cyhpbnRlcm5hbEZpZWxkcykuZmlsdGVyKGsgPT4gaW50ZXJuYWxGaWVsZHNba10uY2xpZW50UmVhZCksXG5dO1xuY29uc3Qgc3BlY2lhbE1hc3RlclF1ZXJ5S2V5cyA9IFtcbiAgLi4ucXVlcnlPcGVyYXRvcnMsXG4gIC4uLk9iamVjdC5rZXlzKGludGVybmFsRmllbGRzKS5maWx0ZXIoayA9PiBpbnRlcm5hbEZpZWxkc1trXS5tYXN0ZXJSZWFkKSxcbl07XG5cbmZ1bmN0aW9uIGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2wpIHtcbiAgY29uc3QgbmV3UXVlcnkgPSBfLmNsb25lRGVlcChxdWVyeSk7XG4gIC8vQ2FuJ3QgYmUgYW55IGV4aXN0aW5nICdfd3Blcm0nIHF1ZXJ5LCB3ZSBkb24ndCBhbGxvdyBjbGllbnQgcXVlcmllcyBvbiB0aGF0LCBubyBuZWVkIHRvICRhbmRcbiAgbmV3UXVlcnkuX3dwZXJtID0geyAkaW46IFtudWxsLCAuLi5hY2xdIH07XG4gIHJldHVybiBuZXdRdWVyeTtcbn1cblxuZnVuY3Rpb24gYWRkUmVhZEFDTChxdWVyeSwgYWNsKSB7XG4gIGNvbnN0IG5ld1F1ZXJ5ID0gXy5jbG9uZURlZXAocXVlcnkpO1xuICAvL0Nhbid0IGJlIGFueSBleGlzdGluZyAnX3JwZXJtJyBxdWVyeSwgd2UgZG9uJ3QgYWxsb3cgY2xpZW50IHF1ZXJpZXMgb24gdGhhdCwgbm8gbmVlZCB0byAkYW5kXG4gIG5ld1F1ZXJ5Ll9ycGVybSA9IHsgJGluOiBbbnVsbCwgJyonLCAuLi5hY2xdIH07XG4gIHJldHVybiBuZXdRdWVyeTtcbn1cblxuLy8gVHJhbnNmb3JtcyBhIFJFU1QgQVBJIGZvcm1hdHRlZCBBQ0wgb2JqZWN0IHRvIG91ciB0d28tZmllbGQgbW9uZ28gZm9ybWF0LlxuY29uc3QgdHJhbnNmb3JtT2JqZWN0QUNMID0gKHsgQUNMLCAuLi5yZXN1bHQgfSkgPT4ge1xuICBpZiAoIUFDTCkge1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICByZXN1bHQuX3dwZXJtID0gW107XG4gIHJlc3VsdC5fcnBlcm0gPSBbXTtcblxuICBmb3IgKGNvbnN0IGVudHJ5IGluIEFDTCkge1xuICAgIGlmIChBQ0xbZW50cnldLnJlYWQpIHtcbiAgICAgIHJlc3VsdC5fcnBlcm0ucHVzaChlbnRyeSk7XG4gICAgfVxuICAgIGlmIChBQ0xbZW50cnldLndyaXRlKSB7XG4gICAgICByZXN1bHQuX3dwZXJtLnB1c2goZW50cnkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufTtcblxuY29uc3QgdmFsaWRhdGVRdWVyeSA9IChcbiAgcXVlcnk6IGFueSxcbiAgaXNNYXN0ZXI6IGJvb2xlYW4sXG4gIGlzTWFpbnRlbmFuY2U6IGJvb2xlYW4sXG4gIHVwZGF0ZTogYm9vbGVhbixcbiAgb3B0aW9uczogP1BhcnNlU2VydmVyT3B0aW9ucyxcbiAgX2RlcHRoOiBudW1iZXIgPSAwXG4pOiB2b2lkID0+IHtcbiAgaWYgKGlzTWFpbnRlbmFuY2UpIHtcbiAgICBpc01hc3RlciA9IHRydWU7XG4gIH1cbiAgY29uc3QgcmMgPSBvcHRpb25zPy5yZXF1ZXN0Q29tcGxleGl0eTtcbiAgaWYgKCFpc01hc3RlciAmJiByYyAmJiByYy5xdWVyeURlcHRoICE9PSAtMSAmJiBfZGVwdGggPiByYy5xdWVyeURlcHRoKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgIGBRdWVyeSBjb25kaXRpb24gbmVzdGluZyBkZXB0aCBleGNlZWRzIG1heGltdW0gYWxsb3dlZCBkZXB0aCBvZiAke3JjLnF1ZXJ5RGVwdGh9YFxuICAgICk7XG4gIH1cbiAgaWYgKHF1ZXJ5LkFDTCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCAnQ2Fubm90IHF1ZXJ5IG9uIEFDTC4nKTtcbiAgfVxuXG4gIGlmIChxdWVyeS4kb3IpIHtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShxdWVyeS4kb3IpKSB7XG4gICAgICBxdWVyeS4kb3IuZm9yRWFjaCh2YWx1ZSA9PiB2YWxpZGF0ZVF1ZXJ5KHZhbHVlLCBpc01hc3RlciwgaXNNYWludGVuYW5jZSwgdXBkYXRlLCBvcHRpb25zLCBfZGVwdGggKyAxKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCAnQmFkICRvciBmb3JtYXQgLSB1c2UgYW4gYXJyYXkgdmFsdWUuJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHF1ZXJ5LiRhbmQpIHtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShxdWVyeS4kYW5kKSkge1xuICAgICAgcXVlcnkuJGFuZC5mb3JFYWNoKHZhbHVlID0+IHZhbGlkYXRlUXVlcnkodmFsdWUsIGlzTWFzdGVyLCBpc01haW50ZW5hbmNlLCB1cGRhdGUsIG9wdGlvbnMsIF9kZXB0aCArIDEpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICdCYWQgJGFuZCBmb3JtYXQgLSB1c2UgYW4gYXJyYXkgdmFsdWUuJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHF1ZXJ5LiRub3IpIHtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShxdWVyeS4kbm9yKSAmJiBxdWVyeS4kbm9yLmxlbmd0aCA+IDApIHtcbiAgICAgIHF1ZXJ5LiRub3IuZm9yRWFjaCh2YWx1ZSA9PiB2YWxpZGF0ZVF1ZXJ5KHZhbHVlLCBpc01hc3RlciwgaXNNYWludGVuYW5jZSwgdXBkYXRlLCBvcHRpb25zLCBfZGVwdGggKyAxKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgJ0JhZCAkbm9yIGZvcm1hdCAtIHVzZSBhbiBhcnJheSBvZiBhdCBsZWFzdCAxIHZhbHVlLidcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgT2JqZWN0LmtleXMocXVlcnkpLmZvckVhY2goa2V5ID0+IHtcbiAgICBpZiAocXVlcnkgJiYgcXVlcnlba2V5XSAmJiBxdWVyeVtrZXldLiRyZWdleCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoIWlzTWFzdGVyICYmIHJjICYmIHJjLmFsbG93UmVnZXggPT09IGZhbHNlKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCAnJHJlZ2V4IG9wZXJhdG9yIGlzIG5vdCBhbGxvd2VkJyk7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIHF1ZXJ5W2tleV0uJHJlZ2V4ICE9PSAnc3RyaW5nJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJyRyZWdleCB2YWx1ZSBtdXN0IGJlIGEgc3RyaW5nJyk7XG4gICAgICB9XG4gICAgICBpZiAocXVlcnlba2V5XS4kb3B0aW9ucyAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBxdWVyeVtrZXldLiRvcHRpb25zICE9PSAnc3RyaW5nJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJyRvcHRpb25zIHZhbHVlIG11c3QgYmUgYSBzdHJpbmcnKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgcXVlcnlba2V5XS4kb3B0aW9ucyA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKCFxdWVyeVtrZXldLiRvcHRpb25zLm1hdGNoKC9eW2lteHN1XSskLykpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICAgYEJhZCAkb3B0aW9ucyB2YWx1ZSBmb3IgcXVlcnk6ICR7cXVlcnlba2V5XS4kb3B0aW9uc31gXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAoXG4gICAgICAha2V5Lm1hdGNoKC9eW2EtekEtWl1bYS16QS1aMC05X1xcLl0qJC8pICYmXG4gICAgICAhc3BlY2lhbFF1ZXJ5S2V5cy5pbmNsdWRlcyhrZXkpICYmXG4gICAgICAhKGlzTWFzdGVyICYmIHNwZWNpYWxNYXN0ZXJRdWVyeUtleXMuaW5jbHVkZXMoa2V5KSlcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCBgSW52YWxpZCBrZXkgbmFtZTogJHtrZXl9YCk7XG4gICAgfVxuICB9KTtcbn07XG5cbi8vIEZpbHRlcnMgb3V0IGFueSBkYXRhIHRoYXQgc2hvdWxkbid0IGJlIG9uIHRoaXMgUkVTVC1mb3JtYXR0ZWQgb2JqZWN0LlxuY29uc3QgZmlsdGVyU2Vuc2l0aXZlRGF0YSA9IChcbiAgaXNNYXN0ZXI6IGJvb2xlYW4sXG4gIGlzTWFpbnRlbmFuY2U6IGJvb2xlYW4sXG4gIGFjbEdyb3VwOiBhbnlbXSxcbiAgYXV0aDogYW55LFxuICBvcGVyYXRpb246IGFueSxcbiAgc2NoZW1hOiBTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXIgfCBhbnksXG4gIGNsYXNzTmFtZTogc3RyaW5nLFxuICBwcm90ZWN0ZWRGaWVsZHM6IG51bGwgfCBBcnJheTxhbnk+LFxuICBvYmplY3Q6IGFueSxcbiAgcHJvdGVjdGVkRmllbGRzT3duZXJFeGVtcHQ6ID9ib29sZWFuXG4pID0+IHtcbiAgbGV0IHVzZXJJZCA9IG51bGw7XG4gIGlmIChhdXRoICYmIGF1dGgudXNlcikgeyB1c2VySWQgPSBhdXRoLnVzZXIuaWQ7IH1cblxuICAvLyByZXBsYWNlIHByb3RlY3RlZEZpZWxkcyB3aGVuIHVzaW5nIHBvaW50ZXItcGVybWlzc2lvbnNcbiAgY29uc3QgcGVybXMgPVxuICAgIHNjaGVtYSAmJiBzY2hlbWEuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zID8gc2NoZW1hLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWUpIDoge307XG4gIGlmIChwZXJtcykge1xuICAgIGNvbnN0IGlzUmVhZE9wZXJhdGlvbiA9IFsnZ2V0JywgJ2ZpbmQnXS5pbmRleE9mKG9wZXJhdGlvbikgPiAtMTtcblxuICAgIGlmIChpc1JlYWRPcGVyYXRpb24gJiYgcGVybXMucHJvdGVjdGVkRmllbGRzKSB7XG4gICAgICAvLyBleHRyYWN0IHByb3RlY3RlZEZpZWxkcyBhZGRlZCB3aXRoIHRoZSBwb2ludGVyLXBlcm1pc3Npb24gcHJlZml4XG4gICAgICBjb25zdCBwcm90ZWN0ZWRGaWVsZHNQb2ludGVyUGVybSA9IE9iamVjdC5rZXlzKHBlcm1zLnByb3RlY3RlZEZpZWxkcylcbiAgICAgICAgLmZpbHRlcihrZXkgPT4ga2V5LnN0YXJ0c1dpdGgoJ3VzZXJGaWVsZDonKSlcbiAgICAgICAgLm1hcChrZXkgPT4ge1xuICAgICAgICAgIHJldHVybiB7IGtleToga2V5LnN1YnN0cmluZygxMCksIHZhbHVlOiBwZXJtcy5wcm90ZWN0ZWRGaWVsZHNba2V5XSB9O1xuICAgICAgICB9KTtcblxuICAgICAgY29uc3QgbmV3UHJvdGVjdGVkRmllbGRzOiBBcnJheTxzdHJpbmc+W10gPSBbXTtcbiAgICAgIGxldCBvdmVycmlkZVByb3RlY3RlZEZpZWxkcyA9IGZhbHNlO1xuXG4gICAgICAvLyBjaGVjayBpZiB0aGUgb2JqZWN0IGdyYW50cyB0aGUgY3VycmVudCB1c2VyIGFjY2VzcyBiYXNlZCBvbiB0aGUgZXh0cmFjdGVkIGZpZWxkc1xuICAgICAgcHJvdGVjdGVkRmllbGRzUG9pbnRlclBlcm0uZm9yRWFjaChwb2ludGVyUGVybSA9PiB7XG4gICAgICAgIGxldCBwb2ludGVyUGVybUluY2x1ZGVzVXNlciA9IGZhbHNlO1xuICAgICAgICBjb25zdCByZWFkVXNlckZpZWxkVmFsdWUgPSBvYmplY3RbcG9pbnRlclBlcm0ua2V5XTtcbiAgICAgICAgaWYgKHJlYWRVc2VyRmllbGRWYWx1ZSkge1xuICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlYWRVc2VyRmllbGRWYWx1ZSkpIHtcbiAgICAgICAgICAgIHBvaW50ZXJQZXJtSW5jbHVkZXNVc2VyID0gcmVhZFVzZXJGaWVsZFZhbHVlLnNvbWUoXG4gICAgICAgICAgICAgIHVzZXIgPT4gdXNlci5vYmplY3RJZCAmJiB1c2VyLm9iamVjdElkID09PSB1c2VySWRcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHBvaW50ZXJQZXJtSW5jbHVkZXNVc2VyID1cbiAgICAgICAgICAgICAgcmVhZFVzZXJGaWVsZFZhbHVlLm9iamVjdElkICYmIHJlYWRVc2VyRmllbGRWYWx1ZS5vYmplY3RJZCA9PT0gdXNlcklkO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChwb2ludGVyUGVybUluY2x1ZGVzVXNlcikge1xuICAgICAgICAgIG92ZXJyaWRlUHJvdGVjdGVkRmllbGRzID0gdHJ1ZTtcbiAgICAgICAgICBuZXdQcm90ZWN0ZWRGaWVsZHMucHVzaChwb2ludGVyUGVybS52YWx1ZSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICAvLyBpZiBhdCBsZWFzdCBvbmUgcG9pbnRlci1wZXJtaXNzaW9uIGFmZmVjdGVkIHRoZSBjdXJyZW50IHVzZXJcbiAgICAgIC8vIGludGVyc2VjdCB2cyBwcm90ZWN0ZWRGaWVsZHMgZnJvbSBwcmV2aW91cyBzdGFnZSAoQHNlZSBhZGRQcm90ZWN0ZWRGaWVsZHMpXG4gICAgICAvLyBTZXRzIHRoZW9yeSAoaW50ZXJzZWN0aW9ucyk6IEEgeCAoQiB4IEMpID09IChBIHggQikgeCBDXG4gICAgICBpZiAob3ZlcnJpZGVQcm90ZWN0ZWRGaWVsZHMgJiYgcHJvdGVjdGVkRmllbGRzKSB7XG4gICAgICAgIG5ld1Byb3RlY3RlZEZpZWxkcy5wdXNoKHByb3RlY3RlZEZpZWxkcyk7XG4gICAgICB9XG4gICAgICAvLyBpbnRlcnNlY3QgYWxsIHNldHMgb2YgcHJvdGVjdGVkRmllbGRzXG4gICAgICBuZXdQcm90ZWN0ZWRGaWVsZHMuZm9yRWFjaChmaWVsZHMgPT4ge1xuICAgICAgICBpZiAoZmllbGRzKSB7XG4gICAgICAgICAgLy8gaWYgdGhlcmUncmUgbm8gcHJvdGN0ZWRGaWVsZHMgYnkgb3RoZXIgY3JpdGVyaWEgKCBpZCAvIHJvbGUgLyBhdXRoKVxuICAgICAgICAgIC8vIHRoZW4gd2UgbXVzdCBpbnRlcnNlY3QgZWFjaCBzZXQgKHBlciB1c2VyRmllbGQpXG4gICAgICAgICAgaWYgKCFwcm90ZWN0ZWRGaWVsZHMpIHtcbiAgICAgICAgICAgIHByb3RlY3RlZEZpZWxkcyA9IGZpZWxkcztcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcHJvdGVjdGVkRmllbGRzID0gcHJvdGVjdGVkRmllbGRzLmZpbHRlcih2ID0+IGZpZWxkcy5pbmNsdWRlcyh2KSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBpc1VzZXJDbGFzcyA9IGNsYXNzTmFtZSA9PT0gJ19Vc2VyJztcbiAgaWYgKGlzVXNlckNsYXNzKSB7XG4gICAgb2JqZWN0LnBhc3N3b3JkID0gb2JqZWN0Ll9oYXNoZWRfcGFzc3dvcmQ7XG4gICAgZGVsZXRlIG9iamVjdC5faGFzaGVkX3Bhc3N3b3JkO1xuICAgIGRlbGV0ZSBvYmplY3Quc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgaWYgKGlzTWFpbnRlbmFuY2UpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgLyogc3BlY2lhbCB0cmVhdCBmb3IgdGhlIHVzZXIgY2xhc3M6IGRvbid0IGZpbHRlciBwcm90ZWN0ZWRGaWVsZHMgaWYgY3VycmVudGx5IGxvZ2dlZGluIHVzZXIgaXNcbiAgdGhlIHJldHJpZXZlZCB1c2VyLCB1bmxlc3MgcHJvdGVjdGVkRmllbGRzT3duZXJFeGVtcHQgaXMgZmFsc2UgKi9cbiAgY29uc3QgaXNPd25lckV4ZW1wdCA9IHByb3RlY3RlZEZpZWxkc093bmVyRXhlbXB0ICE9PSBmYWxzZSAmJiBpc1VzZXJDbGFzcyAmJiB1c2VySWQgJiYgb2JqZWN0Lm9iamVjdElkID09PSB1c2VySWQ7XG4gIGlmICghaXNPd25lckV4ZW1wdCkge1xuICAgIHByb3RlY3RlZEZpZWxkcyAmJiBwcm90ZWN0ZWRGaWVsZHMuZm9yRWFjaChrID0+IGRlbGV0ZSBvYmplY3Rba10pO1xuXG4gICAgLy8gZmllbGRzIG5vdCByZXF1ZXN0ZWQgYnkgY2xpZW50IChleGNsdWRlZCksXG4gICAgLy8gYnV0IHdlcmUgbmVlZGVkIHRvIGFwcGx5IHByb3RlY3RlZEZpZWxkc1xuICAgIHBlcm1zPy5wcm90ZWN0ZWRGaWVsZHM/LnRlbXBvcmFyeUtleXM/LmZvckVhY2goayA9PiBkZWxldGUgb2JqZWN0W2tdKTtcbiAgfVxuXG4gIGZvciAoY29uc3Qga2V5IGluIG9iamVjdCkge1xuICAgIGlmIChrZXkuY2hhckF0KDApID09PSAnXycpIHtcbiAgICAgIGRlbGV0ZSBvYmplY3Rba2V5XTtcbiAgICB9XG4gIH1cblxuICBpZiAoIWlzVXNlckNsYXNzIHx8IGlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIGlmIChhY2xHcm91cC5pbmRleE9mKG9iamVjdC5vYmplY3RJZCkgPiAtMSkge1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cbiAgZGVsZXRlIG9iamVjdC5hdXRoRGF0YTtcbiAgcmV0dXJuIG9iamVjdDtcbn07XG5cbi8vIFJ1bnMgYW4gdXBkYXRlIG9uIHRoZSBkYXRhYmFzZS5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhbiBvYmplY3Qgd2l0aCB0aGUgbmV3IHZhbHVlcyBmb3IgZmllbGRcbi8vIG1vZGlmaWNhdGlvbnMgdGhhdCBkb24ndCBrbm93IHRoZWlyIHJlc3VsdHMgYWhlYWQgb2YgdGltZSwgbGlrZVxuLy8gJ2luY3JlbWVudCcuXG4vLyBPcHRpb25zOlxuLy8gICBhY2w6ICBhIGxpc3Qgb2Ygc3RyaW5ncy4gSWYgdGhlIG9iamVjdCB0byBiZSB1cGRhdGVkIGhhcyBhbiBBQ0wsXG4vLyAgICAgICAgIG9uZSBvZiB0aGUgcHJvdmlkZWQgc3RyaW5ncyBtdXN0IHByb3ZpZGUgdGhlIGNhbGxlciB3aXRoXG4vLyAgICAgICAgIHdyaXRlIHBlcm1pc3Npb25zLlxuY29uc3Qgc3BlY2lhbEtleXNGb3JVcGRhdGUgPSBPYmplY3Qua2V5cyhpbnRlcm5hbEZpZWxkcykuZmlsdGVyKGsgPT4gaW50ZXJuYWxGaWVsZHNba10ubWFzdGVyV3JpdGUpO1xuXG5jb25zdCBpc1NwZWNpYWxVcGRhdGVLZXkgPSBrZXkgPT4ge1xuICByZXR1cm4gc3BlY2lhbEtleXNGb3JVcGRhdGUuaW5kZXhPZihrZXkpID49IDA7XG59O1xuXG5mdW5jdGlvbiBqb2luVGFibGVOYW1lKGNsYXNzTmFtZSwga2V5KSB7XG4gIHJldHVybiBgX0pvaW46JHtrZXl9OiR7Y2xhc3NOYW1lfWA7XG59XG5cbmNvbnN0IGZsYXR0ZW5VcGRhdGVPcGVyYXRvcnNGb3JDcmVhdGUgPSBvYmplY3QgPT4ge1xuICBmb3IgKGNvbnN0IGtleSBpbiBvYmplY3QpIHtcbiAgICBpZiAob2JqZWN0W2tleV0gJiYgb2JqZWN0W2tleV0uX19vcCkge1xuICAgICAgc3dpdGNoIChvYmplY3Rba2V5XS5fX29wKSB7XG4gICAgICAgIGNhc2UgJ0luY3JlbWVudCc6XG4gICAgICAgICAgaWYgKHR5cGVvZiBvYmplY3Rba2V5XS5hbW91bnQgIT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnb2JqZWN0cyB0byBhZGQgbXVzdCBiZSBhbiBhcnJheScpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvYmplY3Rba2V5XSA9IG9iamVjdFtrZXldLmFtb3VudDtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnU2V0T25JbnNlcnQnOlxuICAgICAgICAgIG9iamVjdFtrZXldID0gb2JqZWN0W2tleV0uYW1vdW50O1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdBZGQnOlxuICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShvYmplY3Rba2V5XS5vYmplY3RzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ29iamVjdHMgdG8gYWRkIG11c3QgYmUgYW4gYXJyYXknKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0W2tleV0gPSBvYmplY3Rba2V5XS5vYmplY3RzO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdBZGRVbmlxdWUnOlxuICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShvYmplY3Rba2V5XS5vYmplY3RzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ29iamVjdHMgdG8gYWRkIG11c3QgYmUgYW4gYXJyYXknKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0W2tleV0gPSBvYmplY3Rba2V5XS5vYmplY3RzO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdSZW1vdmUnOlxuICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShvYmplY3Rba2V5XS5vYmplY3RzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ29iamVjdHMgdG8gYWRkIG11c3QgYmUgYW4gYXJyYXknKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0W2tleV0gPSBbXTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnRGVsZXRlJzpcbiAgICAgICAgICBkZWxldGUgb2JqZWN0W2tleV07XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuQ09NTUFORF9VTkFWQUlMQUJMRSxcbiAgICAgICAgICAgIGBUaGUgJHtvYmplY3Rba2V5XS5fX29wfSBvcGVyYXRvciBpcyBub3Qgc3VwcG9ydGVkIHlldC5gXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cbmNvbnN0IHRyYW5zZm9ybUF1dGhEYXRhID0gKGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpID0+IHtcbiAgaWYgKG9iamVjdC5hdXRoRGF0YSAmJiBjbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICBPYmplY3Qua2V5cyhvYmplY3QuYXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgY29uc3QgcHJvdmlkZXJEYXRhID0gb2JqZWN0LmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgIGNvbnN0IGZpZWxkTmFtZSA9IGBfYXV0aF9kYXRhXyR7cHJvdmlkZXJ9YDtcbiAgICAgIGlmIChwcm92aWRlckRhdGEgPT0gbnVsbCkge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHtcbiAgICAgICAgICBfX29wOiAnRGVsZXRlJyxcbiAgICAgICAgfTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0gcHJvdmlkZXJEYXRhO1xuICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gPSB7IHR5cGU6ICdPYmplY3QnIH07XG4gICAgICB9XG4gICAgfSk7XG4gICAgZGVsZXRlIG9iamVjdC5hdXRoRGF0YTtcbiAgfVxufTtcbi8vIFRyYW5zZm9ybXMgYSBEYXRhYmFzZSBmb3JtYXQgQUNMIHRvIGEgUkVTVCBBUEkgZm9ybWF0IEFDTFxuY29uc3QgdW50cmFuc2Zvcm1PYmplY3RBQ0wgPSAoeyBfcnBlcm0sIF93cGVybSwgLi4ub3V0cHV0IH0pID0+IHtcbiAgaWYgKF9ycGVybSB8fCBfd3Blcm0pIHtcbiAgICBvdXRwdXQuQUNMID0ge307XG5cbiAgICAoX3JwZXJtIHx8IFtdKS5mb3JFYWNoKGVudHJ5ID0+IHtcbiAgICAgIGlmICghb3V0cHV0LkFDTFtlbnRyeV0pIHtcbiAgICAgICAgb3V0cHV0LkFDTFtlbnRyeV0gPSB7IHJlYWQ6IHRydWUgfTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG91dHB1dC5BQ0xbZW50cnldWydyZWFkJ10gPSB0cnVlO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgKF93cGVybSB8fCBbXSkuZm9yRWFjaChlbnRyeSA9PiB7XG4gICAgICBpZiAoIW91dHB1dC5BQ0xbZW50cnldKSB7XG4gICAgICAgIG91dHB1dC5BQ0xbZW50cnldID0geyB3cml0ZTogdHJ1ZSB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgb3V0cHV0LkFDTFtlbnRyeV1bJ3dyaXRlJ10gPSB0cnVlO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHJldHVybiBvdXRwdXQ7XG59O1xuXG4vKipcbiAqIFdoZW4gcXVlcnlpbmcsIHRoZSBmaWVsZE5hbWUgbWF5IGJlIGNvbXBvdW5kLCBleHRyYWN0IHRoZSByb290IGZpZWxkTmFtZVxuICogICAgIGB0ZW1wZXJhdHVyZS5jZWxzaXVzYCBiZWNvbWVzIGB0ZW1wZXJhdHVyZWBcbiAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgdGhhdCBtYXkgYmUgYSBjb21wb3VuZCBmaWVsZCBuYW1lXG4gKiBAcmV0dXJucyB7c3RyaW5nfSB0aGUgcm9vdCBuYW1lIG9mIHRoZSBmaWVsZFxuICovXG5jb25zdCBnZXRSb290RmllbGROYW1lID0gKGZpZWxkTmFtZTogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgcmV0dXJuIGZpZWxkTmFtZS5zcGxpdCgnLicpWzBdO1xufTtcblxuY29uc3QgcmVsYXRpb25TY2hlbWEgPSB7XG4gIGZpZWxkczogeyByZWxhdGVkSWQ6IHsgdHlwZTogJ1N0cmluZycgfSwgb3duaW5nSWQ6IHsgdHlwZTogJ1N0cmluZycgfSB9LFxufTtcblxuY29uc3QgY29udmVydEVtYWlsVG9Mb3dlcmNhc2UgPSAob2JqZWN0LCBjbGFzc05hbWUsIG9wdGlvbnMpID0+IHtcbiAgaWYgKGNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJiBvcHRpb25zLmNvbnZlcnRFbWFpbFRvTG93ZXJjYXNlKSB7XG4gICAgaWYgKHR5cGVvZiBvYmplY3RbJ2VtYWlsJ10gPT09ICdzdHJpbmcnKSB7XG4gICAgICBvYmplY3RbJ2VtYWlsJ10gPSBvYmplY3RbJ2VtYWlsJ10udG9Mb3dlckNhc2UoKTtcbiAgICB9XG4gIH1cbn07XG5cbmNvbnN0IGNvbnZlcnRVc2VybmFtZVRvTG93ZXJjYXNlID0gKG9iamVjdCwgY2xhc3NOYW1lLCBvcHRpb25zKSA9PiB7XG4gIGlmIChjbGFzc05hbWUgPT09ICdfVXNlcicgJiYgb3B0aW9ucy5jb252ZXJ0VXNlcm5hbWVUb0xvd2VyY2FzZSkge1xuICAgIGlmICh0eXBlb2Ygb2JqZWN0Wyd1c2VybmFtZSddID09PSAnc3RyaW5nJykge1xuICAgICAgb2JqZWN0Wyd1c2VybmFtZSddID0gb2JqZWN0Wyd1c2VybmFtZSddLnRvTG93ZXJDYXNlKCk7XG4gICAgfVxuICB9XG59O1xuXG5jbGFzcyBEYXRhYmFzZUNvbnRyb2xsZXIge1xuICBhZGFwdGVyOiBTdG9yYWdlQWRhcHRlcjtcbiAgc2NoZW1hQ2FjaGU6IGFueTtcbiAgc2NoZW1hUHJvbWlzZTogP1Byb21pc2U8U2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyPjtcbiAgX3RyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55O1xuICBvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnM7XG4gIGlkZW1wb3RlbmN5T3B0aW9uczogYW55O1xuXG4gIGNvbnN0cnVjdG9yKGFkYXB0ZXI6IFN0b3JhZ2VBZGFwdGVyLCBvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnMpIHtcbiAgICB0aGlzLmFkYXB0ZXIgPSBhZGFwdGVyO1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgdGhpcy5pZGVtcG90ZW5jeU9wdGlvbnMgPSB0aGlzLm9wdGlvbnMuaWRlbXBvdGVuY3lPcHRpb25zIHx8IHt9O1xuICAgIC8vIFByZXZlbnQgbXV0YWJsZSB0aGlzLnNjaGVtYSwgb3RoZXJ3aXNlIG9uZSByZXF1ZXN0IGNvdWxkIHVzZVxuICAgIC8vIG11bHRpcGxlIHNjaGVtYXMsIHNvIGluc3RlYWQgdXNlIGxvYWRTY2hlbWEgdG8gZ2V0IGEgc2NoZW1hLlxuICAgIHRoaXMuc2NoZW1hUHJvbWlzZSA9IG51bGw7XG4gICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24gPSBudWxsO1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG4gIH1cblxuICBjb2xsZWN0aW9uRXhpc3RzKGNsYXNzTmFtZTogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlci5jbGFzc0V4aXN0cyhjbGFzc05hbWUpO1xuICB9XG5cbiAgcHVyZ2VDb2xsZWN0aW9uKGNsYXNzTmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuZ2V0T25lU2NoZW1hKGNsYXNzTmFtZSkpXG4gICAgICAudGhlbihzY2hlbWEgPT4gdGhpcy5hZGFwdGVyLmRlbGV0ZU9iamVjdHNCeVF1ZXJ5KGNsYXNzTmFtZSwgc2NoZW1hLCB7fSkpO1xuICB9XG5cbiAgdmFsaWRhdGVDbGFzc05hbWUoY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIVNjaGVtYUNvbnRyb2xsZXIuY2xhc3NOYW1lSXNWYWxpZChjbGFzc05hbWUpKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0NMQVNTX05BTUUsICdpbnZhbGlkIGNsYXNzTmFtZTogJyArIGNsYXNzTmFtZSlcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIHNjaGVtYUNvbnRyb2xsZXIuXG4gIGxvYWRTY2hlbWEoXG4gICAgb3B0aW9uczogTG9hZFNjaGVtYU9wdGlvbnMgPSB7IGNsZWFyQ2FjaGU6IGZhbHNlIH1cbiAgKTogUHJvbWlzZTxTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXI+IHtcbiAgICBpZiAodGhpcy5zY2hlbWFQcm9taXNlICE9IG51bGwpIHtcbiAgICAgIHJldHVybiB0aGlzLnNjaGVtYVByb21pc2U7XG4gICAgfVxuICAgIHRoaXMuc2NoZW1hUHJvbWlzZSA9IFNjaGVtYUNvbnRyb2xsZXIubG9hZCh0aGlzLmFkYXB0ZXIsIG9wdGlvbnMpO1xuICAgIHRoaXMuc2NoZW1hUHJvbWlzZS50aGVuKFxuICAgICAgKCkgPT4gZGVsZXRlIHRoaXMuc2NoZW1hUHJvbWlzZSxcbiAgICAgICgpID0+IGRlbGV0ZSB0aGlzLnNjaGVtYVByb21pc2VcbiAgICApO1xuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWEob3B0aW9ucyk7XG4gIH1cblxuICBsb2FkU2NoZW1hSWZOZWVkZWQoXG4gICAgc2NoZW1hQ29udHJvbGxlcjogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIG9wdGlvbnM6IExvYWRTY2hlbWFPcHRpb25zID0geyBjbGVhckNhY2hlOiBmYWxzZSB9XG4gICk6IFByb21pc2U8U2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyPiB7XG4gICAgcmV0dXJuIHNjaGVtYUNvbnRyb2xsZXIgPyBQcm9taXNlLnJlc29sdmUoc2NoZW1hQ29udHJvbGxlcikgOiB0aGlzLmxvYWRTY2hlbWEob3B0aW9ucyk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgdGhlIGNsYXNzbmFtZSB0aGF0IGlzIHJlbGF0ZWQgdG8gdGhlIGdpdmVuXG4gIC8vIGNsYXNzbmFtZSB0aHJvdWdoIHRoZSBrZXkuXG4gIC8vIFRPRE86IG1ha2UgdGhpcyBub3QgaW4gdGhlIERhdGFiYXNlQ29udHJvbGxlciBpbnRlcmZhY2VcbiAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXkoY2xhc3NOYW1lOiBzdHJpbmcsIGtleTogc3RyaW5nKTogUHJvbWlzZTw/c3RyaW5nPiB7XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYSgpLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgIHZhciB0ID0gc2NoZW1hLmdldEV4cGVjdGVkVHlwZShjbGFzc05hbWUsIGtleSk7XG4gICAgICBpZiAodCAhPSBudWxsICYmIHR5cGVvZiB0ICE9PSAnc3RyaW5nJyAmJiB0LnR5cGUgPT09ICdSZWxhdGlvbicpIHtcbiAgICAgICAgcmV0dXJuIHQudGFyZ2V0Q2xhc3M7XG4gICAgICB9XG4gICAgICByZXR1cm4gY2xhc3NOYW1lO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gVXNlcyB0aGUgc2NoZW1hIHRvIHZhbGlkYXRlIHRoZSBvYmplY3QgKFJFU1QgQVBJIGZvcm1hdCkuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIG5ldyBzY2hlbWEuXG4gIC8vIFRoaXMgZG9lcyBub3QgdXBkYXRlIHRoaXMuc2NoZW1hLCBiZWNhdXNlIGluIGEgc2l0dWF0aW9uIGxpa2UgYVxuICAvLyBiYXRjaCByZXF1ZXN0LCB0aGF0IGNvdWxkIGNvbmZ1c2Ugb3RoZXIgdXNlcnMgb2YgdGhlIHNjaGVtYS5cbiAgdmFsaWRhdGVPYmplY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0OiBhbnksXG4gICAgcXVlcnk6IGFueSxcbiAgICBydW5PcHRpb25zOiBRdWVyeU9wdGlvbnMsXG4gICAgbWFpbnRlbmFuY2U6IGJvb2xlYW5cbiAgKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgbGV0IHNjaGVtYTtcbiAgICBjb25zdCBhY2wgPSBydW5PcHRpb25zLmFjbDtcbiAgICBjb25zdCBpc01hc3RlciA9IGFjbCA9PT0gdW5kZWZpbmVkO1xuICAgIHZhciBhY2xHcm91cDogc3RyaW5nW10gPSBhY2wgfHwgW107XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzID0+IHtcbiAgICAgICAgc2NoZW1hID0gcztcbiAgICAgICAgaWYgKGlzTWFzdGVyKSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0aGlzLmNhbkFkZEZpZWxkKHNjaGVtYSwgY2xhc3NOYW1lLCBvYmplY3QsIGFjbEdyb3VwLCBydW5PcHRpb25zKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBzY2hlbWEudmFsaWRhdGVPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHF1ZXJ5LCBtYWludGVuYW5jZSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBVcGRhdGVzIG9iamVjdHMgaW4gdGhlIGRhdGFiYXNlIHRoYXQgbWF0Y2ggdGhlIGdpdmVuIHF1ZXJ5LlxuICAgKiBAcGFyYW0ge09iamVjdH0gb3B0aW9uc1xuICAgKiBAcGFyYW0ge2Jvb2xlYW59IFtvcHRpb25zLm1hbnk9ZmFsc2VdIFdoZW4gdHJ1ZSwgdXBkYXRlcyBhbGwgbWF0Y2hpbmcgZG9jdW1lbnRzXG4gICAqICAgYW5kIHJldHVybnMgYHsgbWF0Y2hlZENvdW50LCBtb2RpZmllZENvdW50IH1gIHdoZXJlIHZhbHVlcyBhcmUgbnVtYmVycyBpZiB0aGVcbiAgICogICBzdG9yYWdlIGFkYXB0ZXIgc3VwcG9ydHMgYFVwZGF0ZU1hbnlSZXN1bHRgLCBvciBgdW5kZWZpbmVkYCBvdGhlcndpc2UuXG4gICAqL1xuICB1cGRhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB7IGFjbCwgbWFueSwgdXBzZXJ0LCBhZGRzRmllbGQgfTogRnVsbFF1ZXJ5T3B0aW9ucyA9IHt9LFxuICAgIHNraXBTYW5pdGl6YXRpb246IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZGF0ZU9ubHk6IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICBVdGlscy5jaGVja1Byb2hpYml0ZWRLZXl3b3Jkcyh0aGlzLm9wdGlvbnMsIHVwZGF0ZSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgYCR7ZXJyb3J9YCkpO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgeyB2YWxpZGF0ZUZpbGVVcmxzSW5PYmplY3QgfSA9IHJlcXVpcmUoJy4uL0ZpbGVVcmxWYWxpZGF0b3InKTtcbiAgICAgIHZhbGlkYXRlRmlsZVVybHNJbk9iamVjdCh1cGRhdGUsIHRoaXMub3B0aW9ucyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChlcnJvciBpbnN0YW5jZW9mIFBhcnNlLkVycm9yID8gZXJyb3IgOiBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLCBlcnJvci5tZXNzYWdlIHx8IGVycm9yKSk7XG4gICAgfVxuICAgIGNvbnN0IG9yaWdpbmFsUXVlcnkgPSBxdWVyeTtcbiAgICBjb25zdCBvcmlnaW5hbFVwZGF0ZSA9IHVwZGF0ZTtcbiAgICAvLyBNYWtlIGEgY29weSBvZiB0aGUgb2JqZWN0LCBzbyB3ZSBkb24ndCBtdXRhdGUgdGhlIGluY29taW5nIGRhdGEuXG4gICAgdXBkYXRlID0gc3RydWN0dXJlZENsb25lKHVwZGF0ZSk7XG4gICAgdmFyIHJlbGF0aW9uVXBkYXRlcyA9IFtdO1xuICAgIHZhciBpc01hc3RlciA9IGFjbCA9PT0gdW5kZWZpbmVkO1xuICAgIHZhciBhY2xHcm91cCA9IGFjbCB8fCBbXTtcblxuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWFJZk5lZWRlZCh2YWxpZFNjaGVtYUNvbnRyb2xsZXIpLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICByZXR1cm4gKGlzTWFzdGVyXG4gICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgOiBzY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihjbGFzc05hbWUsIGFjbEdyb3VwLCAndXBkYXRlJylcbiAgICAgIClcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHJlbGF0aW9uVXBkYXRlcyA9IHRoaXMuY29sbGVjdFJlbGF0aW9uVXBkYXRlcyhjbGFzc05hbWUsIG9yaWdpbmFsUXVlcnkub2JqZWN0SWQsIHVwZGF0ZSk7XG4gICAgICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICAgICAgcXVlcnkgPSB0aGlzLmFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAndXBkYXRlJyxcbiAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgIGFjbEdyb3VwXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoYWRkc0ZpZWxkKSB7XG4gICAgICAgICAgICAgIHF1ZXJ5ID0ge1xuICAgICAgICAgICAgICAgICRhbmQ6IFtcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgdGhpcy5hZGRQb2ludGVyUGVybWlzc2lvbnMoXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgJ2FkZEZpZWxkJyxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIGFjbEdyb3VwXG4gICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGFjbCkge1xuICAgICAgICAgICAgcXVlcnkgPSBhZGRXcml0ZUFDTChxdWVyeSwgYWNsKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdmFsaWRhdGVRdWVyeShxdWVyeSwgaXNNYXN0ZXIsIGZhbHNlLCB0cnVlLCB0aGlzLm9wdGlvbnMpO1xuICAgICAgICAgIHJldHVybiBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgICAuZ2V0T25lU2NoZW1hKGNsYXNzTmFtZSwgdHJ1ZSlcbiAgICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAgIC8vIElmIHRoZSBzY2hlbWEgZG9lc24ndCBleGlzdCwgcHJldGVuZCBpdCBleGlzdHMgd2l0aCBubyBmaWVsZHMuIFRoaXMgYmVoYXZpb3JcbiAgICAgICAgICAgICAgLy8gd2lsbCBsaWtlbHkgbmVlZCByZXZpc2l0aW5nLlxuICAgICAgICAgICAgICBpZiAoZXJyb3IgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7IGZpZWxkczoge30gfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgICAgICAgICBPYmplY3Qua2V5cyh1cGRhdGUpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGROYW1lLm1hdGNoKC9eYXV0aERhdGFcXC4vKSkge1xuICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCBmaWVsZCBuYW1lIGZvciB1cGRhdGU6ICR7ZmllbGROYW1lfWBcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IHJvb3RGaWVsZE5hbWUgPSBnZXRSb290RmllbGROYW1lKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgICAgIVNjaGVtYUNvbnRyb2xsZXIuZmllbGROYW1lSXNWYWxpZChyb290RmllbGROYW1lLCBjbGFzc05hbWUpICYmXG4gICAgICAgICAgICAgICAgICAhaXNTcGVjaWFsVXBkYXRlS2V5KHJvb3RGaWVsZE5hbWUpXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIGZpZWxkIG5hbWUgZm9yIHVwZGF0ZTogJHtmaWVsZE5hbWV9YFxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHVwZGF0ZU9wZXJhdGlvbiBpbiB1cGRhdGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgICB1cGRhdGVbdXBkYXRlT3BlcmF0aW9uXSAmJlxuICAgICAgICAgICAgICAgICAgdHlwZW9mIHVwZGF0ZVt1cGRhdGVPcGVyYXRpb25dID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAgICAgICAgICAgT2JqZWN0LmtleXModXBkYXRlW3VwZGF0ZU9wZXJhdGlvbl0pLnNvbWUoXG4gICAgICAgICAgICAgICAgICAgIGlubmVyS2V5ID0+IGlubmVyS2V5LmluY2x1ZGVzKCckJykgfHwgaW5uZXJLZXkuaW5jbHVkZXMoJy4nKVxuICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX05FU1RFRF9LRVksXG4gICAgICAgICAgICAgICAgICAgIFwiTmVzdGVkIGtleXMgc2hvdWxkIG5vdCBjb250YWluIHRoZSAnJCcgb3IgJy4nIGNoYXJhY3RlcnNcIlxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgdXBkYXRlID0gdHJhbnNmb3JtT2JqZWN0QUNMKHVwZGF0ZSk7XG4gICAgICAgICAgICAgIGNvbnZlcnRFbWFpbFRvTG93ZXJjYXNlKHVwZGF0ZSwgY2xhc3NOYW1lLCB0aGlzLm9wdGlvbnMpO1xuICAgICAgICAgICAgICBjb252ZXJ0VXNlcm5hbWVUb0xvd2VyY2FzZSh1cGRhdGUsIGNsYXNzTmFtZSwgdGhpcy5vcHRpb25zKTtcbiAgICAgICAgICAgICAgdHJhbnNmb3JtQXV0aERhdGEoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgICAgICAgICAgIGlmICh2YWxpZGF0ZU9ubHkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmZpbmQoY2xhc3NOYW1lLCBzY2hlbWEsIHF1ZXJ5LCB7IHJlYWRQcmVmZXJlbmNlOiAncHJpbWFyeScgfSkudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgICAgICAgaWYgKCFyZXN1bHQgfHwgIXJlc3VsdC5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmIChtYW55KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci51cGRhdGVPYmplY3RzQnlRdWVyeShcbiAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgdXBkYXRlLFxuICAgICAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9IGVsc2UgaWYgKHVwc2VydCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIudXBzZXJ0T25lT2JqZWN0KFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICB1cGRhdGUsXG4gICAgICAgICAgICAgICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvblxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5maW5kT25lQW5kVXBkYXRlKFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICB1cGRhdGUsXG4gICAgICAgICAgICAgICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvblxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbigocmVzdWx0OiBhbnkpID0+IHtcbiAgICAgICAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodmFsaWRhdGVPbmx5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gdGhpcy5oYW5kbGVSZWxhdGlvblVwZGF0ZXMoXG4gICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICBvcmlnaW5hbFF1ZXJ5Lm9iamVjdElkLFxuICAgICAgICAgICAgdXBkYXRlLFxuICAgICAgICAgICAgcmVsYXRpb25VcGRhdGVzXG4gICAgICAgICAgKS50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgICAgaWYgKHNraXBTYW5pdGl6YXRpb24pIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKG1hbnkpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIG1hdGNoZWRDb3VudDogdHlwZW9mIHJlc3VsdD8ubWF0Y2hlZENvdW50ID09PSAnbnVtYmVyJ1xuICAgICAgICAgICAgICAgID8gcmVzdWx0Lm1hdGNoZWRDb3VudFxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICBtb2RpZmllZENvdW50OiB0eXBlb2YgcmVzdWx0Py5tb2RpZmllZENvdW50ID09PSAnbnVtYmVyJ1xuICAgICAgICAgICAgICAgID8gcmVzdWx0Lm1vZGlmaWVkQ291bnRcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0aGlzLl9zYW5pdGl6ZURhdGFiYXNlUmVzdWx0KG9yaWdpbmFsVXBkYXRlLCByZXN1bHQpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIENvbGxlY3QgYWxsIHJlbGF0aW9uLXVwZGF0aW5nIG9wZXJhdGlvbnMgZnJvbSBhIFJFU1QtZm9ybWF0IHVwZGF0ZS5cbiAgLy8gUmV0dXJucyBhIGxpc3Qgb2YgYWxsIHJlbGF0aW9uIHVwZGF0ZXMgdG8gcGVyZm9ybVxuICAvLyBUaGlzIG11dGF0ZXMgdXBkYXRlLlxuICBjb2xsZWN0UmVsYXRpb25VcGRhdGVzKGNsYXNzTmFtZTogc3RyaW5nLCBvYmplY3RJZDogP3N0cmluZywgdXBkYXRlOiBhbnkpIHtcbiAgICB2YXIgb3BzID0gW107XG4gICAgdmFyIGRlbGV0ZU1lID0gW107XG4gICAgb2JqZWN0SWQgPSB1cGRhdGUub2JqZWN0SWQgfHwgb2JqZWN0SWQ7XG5cbiAgICB2YXIgcHJvY2VzcyA9IChvcCwga2V5KSA9PiB7XG4gICAgICBpZiAoIW9wKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChvcC5fX29wID09ICdBZGRSZWxhdGlvbicpIHtcbiAgICAgICAgb3BzLnB1c2goeyBrZXksIG9wIH0pO1xuICAgICAgICBkZWxldGVNZS5wdXNoKGtleSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChvcC5fX29wID09ICdSZW1vdmVSZWxhdGlvbicpIHtcbiAgICAgICAgb3BzLnB1c2goeyBrZXksIG9wIH0pO1xuICAgICAgICBkZWxldGVNZS5wdXNoKGtleSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChvcC5fX29wID09ICdCYXRjaCcpIHtcbiAgICAgICAgZm9yICh2YXIgeCBvZiBvcC5vcHMpIHtcbiAgICAgICAgICBwcm9jZXNzKHgsIGtleSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuXG4gICAgZm9yIChjb25zdCBrZXkgaW4gdXBkYXRlKSB7XG4gICAgICBwcm9jZXNzKHVwZGF0ZVtrZXldLCBrZXkpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGtleSBvZiBkZWxldGVNZSkge1xuICAgICAgZGVsZXRlIHVwZGF0ZVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gb3BzO1xuICB9XG5cbiAgLy8gUHJvY2Vzc2VzIHJlbGF0aW9uLXVwZGF0aW5nIG9wZXJhdGlvbnMgZnJvbSBhIFJFU1QtZm9ybWF0IHVwZGF0ZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIGFsbCB1cGRhdGVzIGhhdmUgYmVlbiBwZXJmb3JtZWRcbiAgaGFuZGxlUmVsYXRpb25VcGRhdGVzKGNsYXNzTmFtZTogc3RyaW5nLCBvYmplY3RJZDogc3RyaW5nLCB1cGRhdGU6IGFueSwgb3BzOiBhbnkpIHtcbiAgICB2YXIgcGVuZGluZyA9IFtdO1xuICAgIG9iamVjdElkID0gdXBkYXRlLm9iamVjdElkIHx8IG9iamVjdElkO1xuICAgIG9wcy5mb3JFYWNoKCh7IGtleSwgb3AgfSkgPT4ge1xuICAgICAgaWYgKCFvcCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAob3AuX19vcCA9PSAnQWRkUmVsYXRpb24nKSB7XG4gICAgICAgIGZvciAoY29uc3Qgb2JqZWN0IG9mIG9wLm9iamVjdHMpIHtcbiAgICAgICAgICBwZW5kaW5nLnB1c2godGhpcy5hZGRSZWxhdGlvbihrZXksIGNsYXNzTmFtZSwgb2JqZWN0SWQsIG9iamVjdC5vYmplY3RJZCkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChvcC5fX29wID09ICdSZW1vdmVSZWxhdGlvbicpIHtcbiAgICAgICAgZm9yIChjb25zdCBvYmplY3Qgb2Ygb3Aub2JqZWN0cykge1xuICAgICAgICAgIHBlbmRpbmcucHVzaCh0aGlzLnJlbW92ZVJlbGF0aW9uKGtleSwgY2xhc3NOYW1lLCBvYmplY3RJZCwgb2JqZWN0Lm9iamVjdElkKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBQcm9taXNlLmFsbChwZW5kaW5nKTtcbiAgfVxuXG4gIC8vIEFkZHMgYSByZWxhdGlvbi5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBhZGQgd2FzIHN1Y2Nlc3NmdWwuXG4gIGFkZFJlbGF0aW9uKGtleTogc3RyaW5nLCBmcm9tQ2xhc3NOYW1lOiBzdHJpbmcsIGZyb21JZDogc3RyaW5nLCB0b0lkOiBzdHJpbmcpIHtcbiAgICBjb25zdCBkb2MgPSB7XG4gICAgICByZWxhdGVkSWQ6IHRvSWQsXG4gICAgICBvd25pbmdJZDogZnJvbUlkLFxuICAgIH07XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlci51cHNlcnRPbmVPYmplY3QoXG4gICAgICBgX0pvaW46JHtrZXl9OiR7ZnJvbUNsYXNzTmFtZX1gLFxuICAgICAgcmVsYXRpb25TY2hlbWEsXG4gICAgICBkb2MsXG4gICAgICBkb2MsXG4gICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvblxuICAgICk7XG4gIH1cblxuICAvLyBSZW1vdmVzIGEgcmVsYXRpb24uXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgc3VjY2Vzc2Z1bGx5IGlmZiB0aGUgcmVtb3ZlIHdhc1xuICAvLyBzdWNjZXNzZnVsLlxuICByZW1vdmVSZWxhdGlvbihrZXk6IHN0cmluZywgZnJvbUNsYXNzTmFtZTogc3RyaW5nLCBmcm9tSWQ6IHN0cmluZywgdG9JZDogc3RyaW5nKSB7XG4gICAgdmFyIGRvYyA9IHtcbiAgICAgIHJlbGF0ZWRJZDogdG9JZCxcbiAgICAgIG93bmluZ0lkOiBmcm9tSWQsXG4gICAgfTtcbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyXG4gICAgICAuZGVsZXRlT2JqZWN0c0J5UXVlcnkoXG4gICAgICAgIGBfSm9pbjoke2tleX06JHtmcm9tQ2xhc3NOYW1lfWAsXG4gICAgICAgIHJlbGF0aW9uU2NoZW1hLFxuICAgICAgICBkb2MsXG4gICAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAvLyBXZSBkb24ndCBjYXJlIGlmIHRoZXkgdHJ5IHRvIGRlbGV0ZSBhIG5vbi1leGlzdGVudCByZWxhdGlvbi5cbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICB9XG5cbiAgLy8gUmVtb3ZlcyBvYmplY3RzIG1hdGNoZXMgdGhpcyBxdWVyeSBmcm9tIHRoZSBkYXRhYmFzZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBvYmplY3Qgd2FzXG4gIC8vIGRlbGV0ZWQuXG4gIC8vIE9wdGlvbnM6XG4gIC8vICAgYWNsOiAgYSBsaXN0IG9mIHN0cmluZ3MuIElmIHRoZSBvYmplY3QgdG8gYmUgdXBkYXRlZCBoYXMgYW4gQUNMLFxuICAvLyAgICAgICAgIG9uZSBvZiB0aGUgcHJvdmlkZWQgc3RyaW5ncyBtdXN0IHByb3ZpZGUgdGhlIGNhbGxlciB3aXRoXG4gIC8vICAgICAgICAgd3JpdGUgcGVybWlzc2lvbnMuXG4gIGRlc3Ryb3koXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICB7IGFjbCB9OiBRdWVyeU9wdGlvbnMgPSB7fSxcbiAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IGlzTWFzdGVyID0gYWNsID09PSB1bmRlZmluZWQ7XG4gICAgY29uc3QgYWNsR3JvdXAgPSBhY2wgfHwgW107XG5cbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hSWZOZWVkZWQodmFsaWRTY2hlbWFDb250cm9sbGVyKS50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICA/IFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAgIDogc2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgJ2RlbGV0ZScpXG4gICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICBpZiAoIWlzTWFzdGVyKSB7XG4gICAgICAgICAgcXVlcnkgPSB0aGlzLmFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAnZGVsZXRlJyxcbiAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgYWNsR3JvdXBcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZC4nKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gZGVsZXRlIGJ5IHF1ZXJ5XG4gICAgICAgIGlmIChhY2wpIHtcbiAgICAgICAgICBxdWVyeSA9IGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2wpO1xuICAgICAgICB9XG4gICAgICAgIHZhbGlkYXRlUXVlcnkocXVlcnksIGlzTWFzdGVyLCBmYWxzZSwgZmFsc2UsIHRoaXMub3B0aW9ucyk7XG4gICAgICAgIHJldHVybiBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgLmdldE9uZVNjaGVtYShjbGFzc05hbWUpXG4gICAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAgIC8vIElmIHRoZSBzY2hlbWEgZG9lc24ndCBleGlzdCwgcHJldGVuZCBpdCBleGlzdHMgd2l0aCBubyBmaWVsZHMuIFRoaXMgYmVoYXZpb3JcbiAgICAgICAgICAgIC8vIHdpbGwgbGlrZWx5IG5lZWQgcmV2aXNpdGluZy5cbiAgICAgICAgICAgIGlmIChlcnJvciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgIHJldHVybiB7IGZpZWxkczoge30gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4ocGFyc2VGb3JtYXRTY2hlbWEgPT5cbiAgICAgICAgICAgIHRoaXMuYWRhcHRlci5kZWxldGVPYmplY3RzQnlRdWVyeShcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICBwYXJzZUZvcm1hdFNjaGVtYSxcbiAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uXG4gICAgICAgICAgICApXG4gICAgICAgICAgKVxuICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAvLyBXaGVuIGRlbGV0aW5nIHNlc3Npb25zIHdoaWxlIGNoYW5naW5nIHBhc3N3b3JkcywgZG9uJ3QgdGhyb3cgYW4gZXJyb3IgaWYgdGhleSBkb24ndCBoYXZlIGFueSBzZXNzaW9ucy5cbiAgICAgICAgICAgIGlmIChjbGFzc05hbWUgPT09ICdfU2Vzc2lvbicgJiYgZXJyb3IuY29kZSA9PT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBJbnNlcnRzIGFuIG9iamVjdCBpbnRvIHRoZSBkYXRhYmFzZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBvYmplY3Qgc2F2ZWQuXG4gIGNyZWF0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvYmplY3Q6IGFueSxcbiAgICB7IGFjbCB9OiBRdWVyeU9wdGlvbnMgPSB7fSxcbiAgICB2YWxpZGF0ZU9ubHk6IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICBVdGlscy5jaGVja1Byb2hpYml0ZWRLZXl3b3Jkcyh0aGlzLm9wdGlvbnMsIG9iamVjdCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgYCR7ZXJyb3J9YCkpO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgeyB2YWxpZGF0ZUZpbGVVcmxzSW5PYmplY3QgfSA9IHJlcXVpcmUoJy4uL0ZpbGVVcmxWYWxpZGF0b3InKTtcbiAgICAgIHZhbGlkYXRlRmlsZVVybHNJbk9iamVjdChvYmplY3QsIHRoaXMub3B0aW9ucyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChlcnJvciBpbnN0YW5jZW9mIFBhcnNlLkVycm9yID8gZXJyb3IgOiBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLCBlcnJvci5tZXNzYWdlIHx8IGVycm9yKSk7XG4gICAgfVxuICAgIC8vIE1ha2UgYSBjb3B5IG9mIHRoZSBvYmplY3QsIHNvIHdlIGRvbid0IG11dGF0ZSB0aGUgaW5jb21pbmcgZGF0YS5cbiAgICBjb25zdCBvcmlnaW5hbE9iamVjdCA9IG9iamVjdDtcbiAgICBvYmplY3QgPSB0cmFuc2Zvcm1PYmplY3RBQ0wob2JqZWN0KTtcblxuICAgIGNvbnZlcnRFbWFpbFRvTG93ZXJjYXNlKG9iamVjdCwgY2xhc3NOYW1lLCB0aGlzLm9wdGlvbnMpO1xuICAgIGNvbnZlcnRVc2VybmFtZVRvTG93ZXJjYXNlKG9iamVjdCwgY2xhc3NOYW1lLCB0aGlzLm9wdGlvbnMpO1xuICAgIG9iamVjdC5jcmVhdGVkQXQgPSB7IGlzbzogb2JqZWN0LmNyZWF0ZWRBdCwgX190eXBlOiAnRGF0ZScgfTtcbiAgICBvYmplY3QudXBkYXRlZEF0ID0geyBpc286IG9iamVjdC51cGRhdGVkQXQsIF9fdHlwZTogJ0RhdGUnIH07XG5cbiAgICB2YXIgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZDtcbiAgICB2YXIgYWNsR3JvdXAgPSBhY2wgfHwgW107XG4gICAgY29uc3QgcmVsYXRpb25VcGRhdGVzID0gdGhpcy5jb2xsZWN0UmVsYXRpb25VcGRhdGVzKGNsYXNzTmFtZSwgbnVsbCwgb2JqZWN0KTtcblxuICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQ2xhc3NOYW1lKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMubG9hZFNjaGVtYUlmTmVlZGVkKHZhbGlkU2NoZW1hQ29udHJvbGxlcikpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICA6IHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsICdjcmVhdGUnKVxuICAgICAgICApXG4gICAgICAgICAgLnRoZW4oKCkgPT4gc2NoZW1hQ29udHJvbGxlci5lbmZvcmNlQ2xhc3NFeGlzdHMoY2xhc3NOYW1lKSlcbiAgICAgICAgICAudGhlbigoKSA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpKVxuICAgICAgICAgIC50aGVuKHNjaGVtYSA9PiB7XG4gICAgICAgICAgICB0cmFuc2Zvcm1BdXRoRGF0YShjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKTtcbiAgICAgICAgICAgIGZsYXR0ZW5VcGRhdGVPcGVyYXRvcnNGb3JDcmVhdGUob2JqZWN0KTtcbiAgICAgICAgICAgIGlmICh2YWxpZGF0ZU9ubHkpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5jcmVhdGVPYmplY3QoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgU2NoZW1hQ29udHJvbGxlci5jb252ZXJ0U2NoZW1hVG9BZGFwdGVyU2NoZW1hKHNjaGVtYSksXG4gICAgICAgICAgICAgIG9iamVjdCxcbiAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHZhbGlkYXRlT25seSkge1xuICAgICAgICAgICAgICByZXR1cm4gb3JpZ2luYWxPYmplY3Q7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5oYW5kbGVSZWxhdGlvblVwZGF0ZXMoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgb2JqZWN0Lm9iamVjdElkLFxuICAgICAgICAgICAgICBvYmplY3QsXG4gICAgICAgICAgICAgIHJlbGF0aW9uVXBkYXRlc1xuICAgICAgICAgICAgKS50aGVuKCgpID0+IHtcbiAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3Nhbml0aXplRGF0YWJhc2VSZXN1bHQob3JpZ2luYWxPYmplY3QsIHJlc3VsdC5vcHNbMF0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGNhbkFkZEZpZWxkKFxuICAgIHNjaGVtYTogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIG9iamVjdDogYW55LFxuICAgIGFjbEdyb3VwOiBzdHJpbmdbXSxcbiAgICBydW5PcHRpb25zOiBRdWVyeU9wdGlvbnNcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgY2xhc3NTY2hlbWEgPSBzY2hlbWEuc2NoZW1hRGF0YVtjbGFzc05hbWVdO1xuICAgIGlmICghY2xhc3NTY2hlbWEpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgZmllbGRzID0gT2JqZWN0LmtleXMob2JqZWN0KTtcbiAgICBjb25zdCBzY2hlbWFGaWVsZHMgPSBPYmplY3Qua2V5cyhjbGFzc1NjaGVtYS5maWVsZHMpO1xuICAgIGNvbnN0IG5ld0tleXMgPSBmaWVsZHMuZmlsdGVyKGZpZWxkID0+IHtcbiAgICAgIC8vIFNraXAgZmllbGRzIHRoYXQgYXJlIHVuc2V0XG4gICAgICBpZiAob2JqZWN0W2ZpZWxkXSAmJiBvYmplY3RbZmllbGRdLl9fb3AgJiYgb2JqZWN0W2ZpZWxkXS5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2NoZW1hRmllbGRzLmluZGV4T2YoZ2V0Um9vdEZpZWxkTmFtZShmaWVsZCkpIDwgMDtcbiAgICB9KTtcbiAgICBpZiAobmV3S2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBhZGRzIGEgbWFya2VyIHRoYXQgbmV3IGZpZWxkIGlzIGJlaW5nIGFkZGluZyBkdXJpbmcgdXBkYXRlXG4gICAgICBydW5PcHRpb25zLmFkZHNGaWVsZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IGFjdGlvbiA9IHJ1bk9wdGlvbnMuYWN0aW9uO1xuICAgICAgcmV0dXJuIHNjaGVtYS52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgJ2FkZEZpZWxkJywgYWN0aW9uKTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgLy8gV29uJ3QgZGVsZXRlIGNvbGxlY3Rpb25zIGluIHRoZSBzeXN0ZW0gbmFtZXNwYWNlXG4gIC8qKlxuICAgKiBEZWxldGUgYWxsIGNsYXNzZXMgYW5kIGNsZWFycyB0aGUgc2NoZW1hIGNhY2hlXG4gICAqXG4gICAqIEBwYXJhbSB7Ym9vbGVhbn0gZmFzdCBzZXQgdG8gdHJ1ZSBpZiBpdCdzIG9rIHRvIGp1c3QgZGVsZXRlIHJvd3MgYW5kIG5vdCBpbmRleGVzXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fSB3aGVuIHRoZSBkZWxldGlvbnMgY29tcGxldGVzXG4gICAqL1xuICBkZWxldGVFdmVyeXRoaW5nKGZhc3Q6IGJvb2xlYW4gPSBmYWxzZSk6IFByb21pc2U8YW55PiB7XG4gICAgdGhpcy5zY2hlbWFQcm9taXNlID0gbnVsbDtcbiAgICBTY2hlbWFDYWNoZS5jbGVhcigpO1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZGVsZXRlQWxsQ2xhc3NlcyhmYXN0KTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIGxpc3Qgb2YgcmVsYXRlZCBpZHMgZ2l2ZW4gYW4gb3duaW5nIGlkLlxuICAvLyBjbGFzc05hbWUgaGVyZSBpcyB0aGUgb3duaW5nIGNsYXNzTmFtZS5cbiAgcmVsYXRlZElkcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBrZXk6IHN0cmluZyxcbiAgICBvd25pbmdJZDogc3RyaW5nLFxuICAgIHF1ZXJ5T3B0aW9uczogUXVlcnlPcHRpb25zXG4gICk6IFByb21pc2U8QXJyYXk8c3RyaW5nPj4ge1xuICAgIGNvbnN0IHsgc2tpcCwgbGltaXQsIHNvcnQgfSA9IHF1ZXJ5T3B0aW9ucztcbiAgICBjb25zdCBmaW5kT3B0aW9ucyA9IHt9O1xuICAgIGlmIChzb3J0ICYmIHNvcnQuY3JlYXRlZEF0ICYmIHRoaXMuYWRhcHRlci5jYW5Tb3J0T25Kb2luVGFibGVzKSB7XG4gICAgICBmaW5kT3B0aW9ucy5zb3J0ID0geyBfaWQ6IHNvcnQuY3JlYXRlZEF0IH07XG4gICAgICBmaW5kT3B0aW9ucy5saW1pdCA9IGxpbWl0O1xuICAgICAgZmluZE9wdGlvbnMuc2tpcCA9IHNraXA7XG4gICAgICBxdWVyeU9wdGlvbnMuc2tpcCA9IDA7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgIC5maW5kKGpvaW5UYWJsZU5hbWUoY2xhc3NOYW1lLCBrZXkpLCByZWxhdGlvblNjaGVtYSwgeyBvd25pbmdJZCB9LCBmaW5kT3B0aW9ucylcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4gcmVzdWx0cy5tYXAocmVzdWx0ID0+IHJlc3VsdC5yZWxhdGVkSWQpKTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIGxpc3Qgb2Ygb3duaW5nIGlkcyBnaXZlbiBzb21lIHJlbGF0ZWQgaWRzLlxuICAvLyBjbGFzc05hbWUgaGVyZSBpcyB0aGUgb3duaW5nIGNsYXNzTmFtZS5cbiAgb3duaW5nSWRzKGNsYXNzTmFtZTogc3RyaW5nLCBrZXk6IHN0cmluZywgcmVsYXRlZElkczogc3RyaW5nW10pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlclxuICAgICAgLmZpbmQoXG4gICAgICAgIGpvaW5UYWJsZU5hbWUoY2xhc3NOYW1lLCBrZXkpLFxuICAgICAgICByZWxhdGlvblNjaGVtYSxcbiAgICAgICAgeyByZWxhdGVkSWQ6IHsgJGluOiByZWxhdGVkSWRzIH0gfSxcbiAgICAgICAgeyBrZXlzOiBbJ293bmluZ0lkJ10gfVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiByZXN1bHRzLm1hcChyZXN1bHQgPT4gcmVzdWx0Lm93bmluZ0lkKSk7XG4gIH1cblxuICAvLyBNb2RpZmllcyBxdWVyeSBzbyB0aGF0IGl0IG5vIGxvbmdlciBoYXMgJGluIG9uIHJlbGF0aW9uIGZpZWxkcywgb3JcbiAgLy8gZXF1YWwtdG8tcG9pbnRlciBjb25zdHJhaW50cyBvbiByZWxhdGlvbiBmaWVsZHMuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBxdWVyeSBpcyBtdXRhdGVkXG4gIHJlZHVjZUluUmVsYXRpb24oY2xhc3NOYW1lOiBzdHJpbmcsIHF1ZXJ5OiBhbnksIHNjaGVtYTogYW55KTogUHJvbWlzZTxhbnk+IHtcbiAgICAvLyBTZWFyY2ggZm9yIGFuIGluLXJlbGF0aW9uIG9yIGVxdWFsLXRvLXJlbGF0aW9uXG4gICAgLy8gTWFrZSBpdCBzZXF1ZW50aWFsIGZvciBub3csIG5vdCBzdXJlIG9mIHBhcmFsbGVpemF0aW9uIHNpZGUgZWZmZWN0c1xuICAgIGNvbnN0IHByb21pc2VzID0gW107XG4gICAgaWYgKHF1ZXJ5Wyckb3InXSkge1xuICAgICAgY29uc3Qgb3JzID0gcXVlcnlbJyRvciddO1xuICAgICAgcHJvbWlzZXMucHVzaChcbiAgICAgICAgLi4ub3JzLm1hcCgoYVF1ZXJ5LCBpbmRleCkgPT4ge1xuICAgICAgICAgIHJldHVybiB0aGlzLnJlZHVjZUluUmVsYXRpb24oY2xhc3NOYW1lLCBhUXVlcnksIHNjaGVtYSkudGhlbihhUXVlcnkgPT4ge1xuICAgICAgICAgICAgcXVlcnlbJyRvciddW2luZGV4XSA9IGFRdWVyeTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChxdWVyeVsnJGFuZCddKSB7XG4gICAgICBjb25zdCBhbmRzID0gcXVlcnlbJyRhbmQnXTtcbiAgICAgIHByb21pc2VzLnB1c2goXG4gICAgICAgIC4uLmFuZHMubWFwKChhUXVlcnksIGluZGV4KSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlSW5SZWxhdGlvbihjbGFzc05hbWUsIGFRdWVyeSwgc2NoZW1hKS50aGVuKGFRdWVyeSA9PiB7XG4gICAgICAgICAgICBxdWVyeVsnJGFuZCddW2luZGV4XSA9IGFRdWVyeTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgb3RoZXJLZXlzID0gT2JqZWN0LmtleXMocXVlcnkpLm1hcChrZXkgPT4ge1xuICAgICAgaWYgKGtleSA9PT0gJyRhbmQnIHx8IGtleSA9PT0gJyRvcicpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY29uc3QgdCA9IHNjaGVtYS5nZXRFeHBlY3RlZFR5cGUoY2xhc3NOYW1lLCBrZXkpO1xuICAgICAgaWYgKCF0IHx8IHQudHlwZSAhPT0gJ1JlbGF0aW9uJykge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHF1ZXJ5KTtcbiAgICAgIH1cbiAgICAgIGxldCBxdWVyaWVzOiA/KGFueVtdKSA9IG51bGw7XG4gICAgICBpZiAoXG4gICAgICAgIHF1ZXJ5W2tleV0gJiZcbiAgICAgICAgKHF1ZXJ5W2tleV1bJyRpbiddIHx8XG4gICAgICAgICAgcXVlcnlba2V5XVsnJG5lJ10gfHxcbiAgICAgICAgICBxdWVyeVtrZXldWyckbmluJ10gfHxcbiAgICAgICAgICBxdWVyeVtrZXldLl9fdHlwZSA9PSAnUG9pbnRlcicpXG4gICAgICApIHtcbiAgICAgICAgLy8gQnVpbGQgdGhlIGxpc3Qgb2YgcXVlcmllc1xuICAgICAgICBxdWVyaWVzID0gT2JqZWN0LmtleXMocXVlcnlba2V5XSkubWFwKGNvbnN0cmFpbnRLZXkgPT4ge1xuICAgICAgICAgIGxldCByZWxhdGVkSWRzO1xuICAgICAgICAgIGxldCBpc05lZ2F0aW9uID0gZmFsc2U7XG4gICAgICAgICAgaWYgKGNvbnN0cmFpbnRLZXkgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMgPSBbcXVlcnlba2V5XS5vYmplY3RJZF07XG4gICAgICAgICAgfSBlbHNlIGlmIChjb25zdHJhaW50S2V5ID09ICckaW4nKSB7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gcXVlcnlba2V5XVsnJGluJ10ubWFwKHIgPT4gci5vYmplY3RJZCk7XG4gICAgICAgICAgfSBlbHNlIGlmIChjb25zdHJhaW50S2V5ID09ICckbmluJykge1xuICAgICAgICAgICAgaXNOZWdhdGlvbiA9IHRydWU7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gcXVlcnlba2V5XVsnJG5pbiddLm1hcChyID0+IHIub2JqZWN0SWQpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoY29uc3RyYWludEtleSA9PSAnJG5lJykge1xuICAgICAgICAgICAgaXNOZWdhdGlvbiA9IHRydWU7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gW3F1ZXJ5W2tleV1bJyRuZSddLm9iamVjdElkXTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgaXNOZWdhdGlvbixcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBxdWVyaWVzID0gW3sgaXNOZWdhdGlvbjogZmFsc2UsIHJlbGF0ZWRJZHM6IFtdIH1dO1xuICAgICAgfVxuXG4gICAgICAvLyByZW1vdmUgdGhlIGN1cnJlbnQgcXVlcnlLZXkgYXMgd2UgZG9uLHQgbmVlZCBpdCBhbnltb3JlXG4gICAgICBkZWxldGUgcXVlcnlba2V5XTtcbiAgICAgIC8vIGV4ZWN1dGUgZWFjaCBxdWVyeSBpbmRlcGVuZGVudGx5IHRvIGJ1aWxkIHRoZSBsaXN0IG9mXG4gICAgICAvLyAkaW4gLyAkbmluXG4gICAgICBjb25zdCBwcm9taXNlcyA9IHF1ZXJpZXMubWFwKHEgPT4ge1xuICAgICAgICBpZiAoIXEpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXMub3duaW5nSWRzKGNsYXNzTmFtZSwga2V5LCBxLnJlbGF0ZWRJZHMpLnRoZW4oaWRzID0+IHtcbiAgICAgICAgICBpZiAocS5pc05lZ2F0aW9uKSB7XG4gICAgICAgICAgICB0aGlzLmFkZE5vdEluT2JqZWN0SWRzSWRzKGlkcywgcXVlcnkpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmFkZEluT2JqZWN0SWRzSWRzKGlkcywgcXVlcnkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcykudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKFsuLi5wcm9taXNlcywgLi4ub3RoZXJLZXlzXSkudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHF1ZXJ5KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIE1vZGlmaWVzIHF1ZXJ5IHNvIHRoYXQgaXQgbm8gbG9uZ2VyIGhhcyAkcmVsYXRlZFRvXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBxdWVyeSBpcyBtdXRhdGVkXG4gIHJlZHVjZVJlbGF0aW9uS2V5cyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogYW55LFxuICAgIHF1ZXJ5T3B0aW9uczogYW55LFxuICAgIGF1dGg6IGFueSA9IHt9LFxuICAgIGFjbEdyb3VwOiBhbnlbXSA9IFtdLFxuICAgIGlzTWFzdGVyOiBib29sZWFuID0gZmFsc2UsXG4gICAgc2NoZW1hQ29udHJvbGxlcjogP1NjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiA/UHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHF1ZXJ5Wyckb3InXSkge1xuICAgICAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgICAgICBxdWVyeVsnJG9yJ10ubWFwKGFRdWVyeSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgYVF1ZXJ5LFxuICAgICAgICAgICAgcXVlcnlPcHRpb25zLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChxdWVyeVsnJGFuZCddKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIHF1ZXJ5WyckYW5kJ10ubWFwKGFRdWVyeSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgYVF1ZXJ5LFxuICAgICAgICAgICAgcXVlcnlPcHRpb25zLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChBcnJheS5pc0FycmF5KHF1ZXJ5Wyckbm9yJ10pKSB7XG4gICAgICAvLyBHdWFyZCB3aXRoIEFycmF5LmlzQXJyYXkgKHVubGlrZSB0aGUgbGVnYWN5ICRvci8kYW5kIGNoZWNrcyBhYm92ZSkgc28gYVxuICAgICAgLy8gbWFsZm9ybWVkIG5vbi1hcnJheSAkbm9yIHN0aWxsIGZhbGxzIHRocm91Z2ggdG8gdmFsaWRhdGVRdWVyeSBhbmQgeWllbGRzXG4gICAgICAvLyB0aGUgZXhpc3RpbmcgSU5WQUxJRF9RVUVSWSBlcnJvciBpbnN0ZWFkIG9mIHRocm93aW5nIGhlcmUuXG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIHF1ZXJ5Wyckbm9yJ10ubWFwKGFRdWVyeSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgYVF1ZXJ5LFxuICAgICAgICAgICAgcXVlcnlPcHRpb25zLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuICAgIHZhciByZWxhdGVkVG8gPSBxdWVyeVsnJHJlbGF0ZWRUbyddO1xuICAgIGlmIChyZWxhdGVkVG8pIHtcbiAgICAgIHJldHVybiB0aGlzLmF1dGhvcml6ZVJlbGF0ZWRUb1F1ZXJ5KHJlbGF0ZWRUbywgYXV0aCwgYWNsR3JvdXAsIGlzTWFzdGVyLCBzY2hlbWFDb250cm9sbGVyKVxuICAgICAgICAudGhlbihjYW5SZWFkT3duaW5nT2JqZWN0ID0+IHtcbiAgICAgICAgICBkZWxldGUgcXVlcnlbJyRyZWxhdGVkVG8nXTtcbiAgICAgICAgICBpZiAoIWNhblJlYWRPd25pbmdPYmplY3QpIHtcbiAgICAgICAgICAgIC8vIFRoZSBjYWxsZXIgaXMgbm90IGFsbG93ZWQgdG8gcmVhZCB0aGUgb3duaW5nIG9iamVjdCwgc28gdGhlXG4gICAgICAgICAgICAvLyByZWxhdGlvbiBtdXN0IG5vdCBkaXNjbG9zZSBhbnkgbGlua2VkIG9iamVjdHMgKGFuZCBtdXN0IG5vdCBhY3RcbiAgICAgICAgICAgIC8vIGFzIGEgbWVtYmVyc2hpcCBvcmFjbGUgZm9yIGEga25vd24gcmVsYXRlZCBpZCkuXG4gICAgICAgICAgICB0aGlzLmFkZEluT2JqZWN0SWRzSWRzKFtdLCBxdWVyeSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5yZWR1Y2VSZWxhdGlvbktleXMoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgIHF1ZXJ5T3B0aW9ucyxcbiAgICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgICAgYWNsR3JvdXAsXG4gICAgICAgICAgICAgIGlzTWFzdGVyLFxuICAgICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gdGhpcy5yZWxhdGVkSWRzKFxuICAgICAgICAgICAgcmVsYXRlZFRvLm9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgICByZWxhdGVkVG8ua2V5LFxuICAgICAgICAgICAgcmVsYXRlZFRvLm9iamVjdC5vYmplY3RJZCxcbiAgICAgICAgICAgIHF1ZXJ5T3B0aW9uc1xuICAgICAgICAgICkudGhlbihpZHMgPT4ge1xuICAgICAgICAgICAgdGhpcy5hZGRJbk9iamVjdElkc0lkcyhpZHMsIHF1ZXJ5KTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnJlZHVjZVJlbGF0aW9uS2V5cyhcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgcXVlcnlPcHRpb25zLFxuICAgICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXJcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHt9KTtcbiAgICB9XG4gIH1cblxuICAvLyBBdXRob3JpemVzIGEgYCRyZWxhdGVkVG9gIHJlbGF0aW9uIHF1ZXJ5IGFnYWluc3QgdGhlIG93bmluZyBvYmplY3QgYmVmb3JlXG4gIC8vIGl0cyBqb2luIHRhYmxlIGlzIHJlYWQgYnkgYHJlbGF0ZWRJZHNgLiBXaXRob3V0IHRoaXMgY2hlY2ssIGAkcmVsYXRlZFRvYFxuICAvLyBieXBhc3NlcyBib3RoIGBwcm90ZWN0ZWRGaWVsZHNgIGFuZCB0aGUgb3duaW5nIG9iamVjdCdzIEFDTC9DTFAsIGJlY2F1c2VcbiAgLy8gdGhlIGRvd25zdHJlYW0gcHJvdGVjdGVkLWZpZWxkIGFuZCBBQ0wgZmlsdGVycyBvbmx5IGFwcGx5IHRvIHRoZSBxdWVyaWVkXG4gIC8vICh0YXJnZXQpIGNsYXNzLCBuZXZlciB0byB0aGUgb3duaW5nIGNsYXNzIHJlZmVyZW5jZWQgYnkgYCRyZWxhdGVkVG9gLlxuICAvL1xuICAvLyAtIFRocm93cyBgT1BFUkFUSU9OX0ZPUkJJRERFTmAgaWYgdGhlIHJlbGF0aW9uIGtleSBpcyBhIHByb3RlY3RlZCBmaWVsZCBvblxuICAvLyAgIHRoZSBvd25pbmcgY2xhc3MgZm9yIHRoZSBjYWxsZXIncyBhdXRoIGNvbnRleHQgKG1pcnJvcnMgdGhlIHByb3RlY3RlZFxuICAvLyAgIFdIRVJFLWZpZWxkIGRlbmlhbCBpbiBgUmVzdFF1ZXJ5LmRlbnlQcm90ZWN0ZWRGaWVsZHNgKS5cbiAgLy8gLSBSZXNvbHZlcyB0byBgdHJ1ZWAgaWYgdGhlIGNhbGxlciBtYXkgcmVhZCB0aGUgb3duaW5nIG9iamVjdCAoc28gdGhlIGpvaW5cbiAgLy8gICB0YWJsZSByZWFkIG1heSBwcm9jZWVkKSwgb3IgYGZhbHNlYCBvdGhlcndpc2UgKHNvIHRoZSByZWxhdGlvbiB5aWVsZHMgbm9cbiAgLy8gICByZXN1bHRzIGFuZCBjYW5ub3QgYmUgdXNlZCBhcyBhIG1lbWJlcnNoaXAgb3JhY2xlKS5cbiAgLy9cbiAgLy8gTWFzdGVyIGFuZCBtYWludGVuYW5jZSByZXF1ZXN0cyBieXBhc3MgYm90aCBjaGVja3MgYnkgZGVzaWduLlxuICBhdXRob3JpemVSZWxhdGVkVG9RdWVyeShcbiAgICByZWxhdGVkVG86IGFueSxcbiAgICBhdXRoOiBhbnkgPSB7fSxcbiAgICBhY2xHcm91cDogYW55W10gPSBbXSxcbiAgICBpc01hc3RlcjogYm9vbGVhbiA9IGZhbHNlLFxuICAgIHNjaGVtYUNvbnRyb2xsZXI6ID9TY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXJcbiAgKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgaWYgKGlzTWFzdGVyKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHRydWUpO1xuICAgIH1cbiAgICBjb25zdCBvd25pbmdDbGFzc05hbWUgPSByZWxhdGVkVG8gJiYgcmVsYXRlZFRvLm9iamVjdCAmJiByZWxhdGVkVG8ub2JqZWN0LmNsYXNzTmFtZTtcbiAgICBjb25zdCBvd25pbmdJZCA9IHJlbGF0ZWRUbyAmJiByZWxhdGVkVG8ub2JqZWN0ICYmIHJlbGF0ZWRUby5vYmplY3Qub2JqZWN0SWQ7XG4gICAgY29uc3QgcmVsYXRpb25LZXkgPSByZWxhdGVkVG8gJiYgcmVsYXRlZFRvLmtleTtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hSWZOZWVkZWQoc2NoZW1hQ29udHJvbGxlcikudGhlbihsb2FkZWRTY2hlbWEgPT4ge1xuICAgICAgLy8gMS4gVGhlIHJlbGF0aW9uIGtleSBtdXN0IG5vdCBiZSBhIHByb3RlY3RlZCBmaWVsZCBvbiB0aGUgb3duaW5nIGNsYXNzLlxuICAgICAgY29uc3QgcHJvdGVjdGVkRmllbGRzID1cbiAgICAgICAgdGhpcy5hZGRQcm90ZWN0ZWRGaWVsZHMobG9hZGVkU2NoZW1hLCBvd25pbmdDbGFzc05hbWUsIHt9LCBhY2xHcm91cCwgYXV0aCkgfHwgW107XG4gICAgICBjb25zdCByb290RmllbGQgPSB0eXBlb2YgcmVsYXRpb25LZXkgPT09ICdzdHJpbmcnID8gcmVsYXRpb25LZXkuc3BsaXQoJy4nKVswXSA6IHJlbGF0aW9uS2V5O1xuICAgICAgaWYgKHByb3RlY3RlZEZpZWxkcy5pbmNsdWRlcyhyZWxhdGlvbktleSkgfHwgcHJvdGVjdGVkRmllbGRzLmluY2x1ZGVzKHJvb3RGaWVsZCkpIHtcbiAgICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICBgVGhpcyB1c2VyIGlzIG5vdCBhbGxvd2VkIHRvIHF1ZXJ5ICR7cmVsYXRpb25LZXl9IG9uIGNsYXNzICR7b3duaW5nQ2xhc3NOYW1lfWAsXG4gICAgICAgICAgdGhpcy5vcHRpb25zXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyAyLiBUaGUgY2FsbGVyIG11c3QgYmUgYWJsZSB0byByZWFkIHRoZSBvd25pbmcgb2JqZWN0IGl0c2VsZi4gQSByZWFkIHdpdGhcbiAgICAgIC8vICAgIHRoZSBjYWxsZXIncyBhdXRoIGNvbnRleHQgYXBwbGllcyB0aGUgb3duaW5nIGNsYXNzIENMUCwgdGhlIG9iamVjdFxuICAgICAgLy8gICAgQUNMIGFuZCBwb2ludGVyIHBlcm1pc3Npb25zLiBBbnkgXCJub3QgYXV0aG9yaXplZFwiIG9yIFwibm90IGZvdW5kXCJcbiAgICAgIC8vICAgIG91dGNvbWUgbWFwcyB0byBcImNhbm5vdCByZWFkXCIsIHNvIHRoZSByZWxhdGlvbiByZXR1cm5zIG5vIHJlc3VsdHMuXG4gICAgICByZXR1cm4gdGhpcy5maW5kKFxuICAgICAgICBvd25pbmdDbGFzc05hbWUsXG4gICAgICAgIHsgb2JqZWN0SWQ6IG93bmluZ0lkIH0sXG4gICAgICAgIHsgYWNsOiBhY2xHcm91cCwgbGltaXQ6IDEsIGtleXM6IFsnb2JqZWN0SWQnXSwgb3A6ICdnZXQnIH0sXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGxvYWRlZFNjaGVtYVxuICAgICAgKVxuICAgICAgICAudGhlbihyZXN1bHRzID0+IEFycmF5LmlzQXJyYXkocmVzdWx0cykgJiYgcmVzdWx0cy5sZW5ndGggPiAwKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgUGFyc2UuRXJyb3IgJiZcbiAgICAgICAgICAgIChlcnJvci5jb2RlID09PSBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOIHx8XG4gICAgICAgICAgICAgIGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGFkZEluT2JqZWN0SWRzSWRzKGlkczogP0FycmF5PHN0cmluZz4gPSBudWxsLCBxdWVyeTogYW55KSB7XG4gICAgY29uc3QgaWRzRnJvbVN0cmluZzogP0FycmF5PHN0cmluZz4gPVxuICAgICAgdHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09PSAnc3RyaW5nJyA/IFtxdWVyeS5vYmplY3RJZF0gOiBudWxsO1xuICAgIGNvbnN0IGlkc0Zyb21FcTogP0FycmF5PHN0cmluZz4gPVxuICAgICAgcXVlcnkub2JqZWN0SWQgJiYgcXVlcnkub2JqZWN0SWRbJyRlcSddID8gW3F1ZXJ5Lm9iamVjdElkWyckZXEnXV0gOiBudWxsO1xuICAgIGNvbnN0IGlkc0Zyb21JbjogP0FycmF5PHN0cmluZz4gPVxuICAgICAgcXVlcnkub2JqZWN0SWQgJiYgcXVlcnkub2JqZWN0SWRbJyRpbiddID8gcXVlcnkub2JqZWN0SWRbJyRpbiddIDogbnVsbDtcblxuICAgIC8vIEBmbG93LWRpc2FibGUtbmV4dFxuICAgIGNvbnN0IGFsbElkczogQXJyYXk8QXJyYXk8c3RyaW5nPj4gPSBbaWRzRnJvbVN0cmluZywgaWRzRnJvbUVxLCBpZHNGcm9tSW4sIGlkc10uZmlsdGVyKFxuICAgICAgbGlzdCA9PiBsaXN0ICE9PSBudWxsXG4gICAgKTtcbiAgICBjb25zdCB0b3RhbExlbmd0aCA9IGFsbElkcy5yZWR1Y2UoKG1lbW8sIGxpc3QpID0+IG1lbW8gKyBsaXN0Lmxlbmd0aCwgMCk7XG5cbiAgICBsZXQgaWRzSW50ZXJzZWN0aW9uID0gW107XG4gICAgaWYgKHRvdGFsTGVuZ3RoID4gMTI1KSB7XG4gICAgICBpZHNJbnRlcnNlY3Rpb24gPSBpbnRlcnNlY3QuYmlnKGFsbElkcyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlkc0ludGVyc2VjdGlvbiA9IGludGVyc2VjdChhbGxJZHMpO1xuICAgIH1cblxuICAgIC8vIE5lZWQgdG8gbWFrZSBzdXJlIHdlIGRvbid0IGNsb2JiZXIgZXhpc3Rpbmcgc2hvcnRoYW5kICRlcSBjb25zdHJhaW50cyBvbiBvYmplY3RJZC5cbiAgICBpZiAoISgnb2JqZWN0SWQnIGluIHF1ZXJ5KSkge1xuICAgICAgcXVlcnkub2JqZWN0SWQgPSB7XG4gICAgICAgICRpbjogdW5kZWZpbmVkLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHF1ZXJ5Lm9iamVjdElkID0ge1xuICAgICAgICAkaW46IHVuZGVmaW5lZCxcbiAgICAgICAgJGVxOiBxdWVyeS5vYmplY3RJZCxcbiAgICAgIH07XG4gICAgfVxuICAgIHF1ZXJ5Lm9iamVjdElkWyckaW4nXSA9IGlkc0ludGVyc2VjdGlvbjtcblxuICAgIHJldHVybiBxdWVyeTtcbiAgfVxuXG4gIGFkZE5vdEluT2JqZWN0SWRzSWRzKGlkczogc3RyaW5nW10gPSBbXSwgcXVlcnk6IGFueSkge1xuICAgIGNvbnN0IGlkc0Zyb21OaW4gPSBxdWVyeS5vYmplY3RJZCAmJiBxdWVyeS5vYmplY3RJZFsnJG5pbiddID8gcXVlcnkub2JqZWN0SWRbJyRuaW4nXSA6IFtdO1xuICAgIGxldCBhbGxJZHMgPSBbLi4uaWRzRnJvbU5pbiwgLi4uaWRzXS5maWx0ZXIobGlzdCA9PiBsaXN0ICE9PSBudWxsKTtcblxuICAgIC8vIG1ha2UgYSBzZXQgYW5kIHNwcmVhZCB0byByZW1vdmUgZHVwbGljYXRlc1xuICAgIGFsbElkcyA9IFsuLi5uZXcgU2V0KGFsbElkcyldO1xuXG4gICAgLy8gTmVlZCB0byBtYWtlIHN1cmUgd2UgZG9uJ3QgY2xvYmJlciBleGlzdGluZyBzaG9ydGhhbmQgJGVxIGNvbnN0cmFpbnRzIG9uIG9iamVjdElkLlxuICAgIGlmICghKCdvYmplY3RJZCcgaW4gcXVlcnkpKSB7XG4gICAgICBxdWVyeS5vYmplY3RJZCA9IHtcbiAgICAgICAgJG5pbjogdW5kZWZpbmVkLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHF1ZXJ5Lm9iamVjdElkID0ge1xuICAgICAgICAkbmluOiB1bmRlZmluZWQsXG4gICAgICAgICRlcTogcXVlcnkub2JqZWN0SWQsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHF1ZXJ5Lm9iamVjdElkWyckbmluJ10gPSBhbGxJZHM7XG4gICAgcmV0dXJuIHF1ZXJ5O1xuICB9XG5cbiAgLy8gUnVucyBhIHF1ZXJ5IG9uIHRoZSBkYXRhYmFzZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byBhIGxpc3Qgb2YgaXRlbXMuXG4gIC8vIE9wdGlvbnM6XG4gIC8vICAgc2tpcCAgICBudW1iZXIgb2YgcmVzdWx0cyB0byBza2lwLlxuICAvLyAgIGxpbWl0ICAgbGltaXQgdG8gdGhpcyBudW1iZXIgb2YgcmVzdWx0cy5cbiAgLy8gICBzb3J0ICAgIGFuIG9iamVjdCB3aGVyZSBrZXlzIGFyZSB0aGUgZmllbGRzIHRvIHNvcnQgYnkuXG4gIC8vICAgICAgICAgICB0aGUgdmFsdWUgaXMgKzEgZm9yIGFzY2VuZGluZywgLTEgZm9yIGRlc2NlbmRpbmcuXG4gIC8vICAgY291bnQgICBydW4gYSBjb3VudCBpbnN0ZWFkIG9mIHJldHVybmluZyByZXN1bHRzLlxuICAvLyAgIGFjbCAgICAgcmVzdHJpY3QgdGhpcyBvcGVyYXRpb24gd2l0aCBhbiBBQ0wgZm9yIHRoZSBwcm92aWRlZCBhcnJheVxuICAvLyAgICAgICAgICAgb2YgdXNlciBvYmplY3RJZHMgYW5kIHJvbGVzLiBhY2w6IG51bGwgbWVhbnMgbm8gdXNlci5cbiAgLy8gICAgICAgICAgIHdoZW4gdGhpcyBmaWVsZCBpcyBub3QgcHJlc2VudCwgZG9uJ3QgZG8gYW55dGhpbmcgcmVnYXJkaW5nIEFDTHMuXG4gIC8vICBjYXNlSW5zZW5zaXRpdmUgbWFrZSBzdHJpbmcgY29tcGFyaXNvbnMgY2FzZSBpbnNlbnNpdGl2ZVxuICAvLyBUT0RPOiBtYWtlIHVzZXJJZHMgbm90IG5lZWRlZCBoZXJlLiBUaGUgZGIgYWRhcHRlciBzaG91bGRuJ3Qga25vd1xuICAvLyBhbnl0aGluZyBhYm91dCB1c2VycywgaWRlYWxseS4gVGhlbiwgaW1wcm92ZSB0aGUgZm9ybWF0IG9mIHRoZSBBQ0xcbiAgLy8gYXJnIHRvIHdvcmsgbGlrZSB0aGUgb3RoZXJzLlxuICBmaW5kKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHF1ZXJ5OiBhbnksXG4gICAge1xuICAgICAgc2tpcCxcbiAgICAgIGxpbWl0LFxuICAgICAgYWNsLFxuICAgICAgc29ydCA9IHt9LFxuICAgICAgY291bnQsXG4gICAgICBrZXlzLFxuICAgICAgb3AsXG4gICAgICBkaXN0aW5jdCxcbiAgICAgIHBpcGVsaW5lLFxuICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICBoaW50LFxuICAgICAgY2FzZUluc2Vuc2l0aXZlID0gZmFsc2UsXG4gICAgICBleHBsYWluLFxuICAgICAgY29tbWVudCxcbiAgICAgIHJhd1ZhbHVlcyxcbiAgICAgIHJhd0ZpZWxkTmFtZXMsXG4gICAgfTogYW55ID0ge30sXG4gICAgYXV0aDogYW55ID0ge30sXG4gICAgdmFsaWRTY2hlbWFDb250cm9sbGVyOiBTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXJcbiAgKTogUHJvbWlzZTxhbnk+IHtcbiAgICBjb25zdCBpc01haW50ZW5hbmNlID0gYXV0aC5pc01haW50ZW5hbmNlO1xuICAgIGNvbnN0IGlzTWFzdGVyID0gYWNsID09PSB1bmRlZmluZWQgfHwgaXNNYWludGVuYW5jZTtcbiAgICBjb25zdCBhY2xHcm91cCA9IGFjbCB8fCBbXTtcbiAgICBvcCA9XG4gICAgICBvcCB8fCAodHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09ICdzdHJpbmcnICYmIE9iamVjdC5rZXlzKHF1ZXJ5KS5sZW5ndGggPT09IDEgPyAnZ2V0JyA6ICdmaW5kJyk7XG4gICAgLy8gQ291bnQgb3BlcmF0aW9uIGlmIGNvdW50aW5nXG4gICAgb3AgPSBjb3VudCA9PT0gdHJ1ZSA/ICdjb3VudCcgOiBvcDtcblxuICAgIGxldCBjbGFzc0V4aXN0cyA9IHRydWU7XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYUlmTmVlZGVkKHZhbGlkU2NoZW1hQ29udHJvbGxlcikudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgIC8vQWxsb3cgdm9sYXRpbGUgY2xhc3NlcyBpZiBxdWVyeWluZyB3aXRoIE1hc3RlciAoZm9yIF9QdXNoU3RhdHVzKVxuICAgICAgLy9UT0RPOiBNb3ZlIHZvbGF0aWxlIGNsYXNzZXMgY29uY2VwdCBpbnRvIG1vbmdvIGFkYXB0ZXIsIHBvc3RncmVzIGFkYXB0ZXIgc2hvdWxkbid0IGNhcmVcbiAgICAgIC8vdGhhdCBhcGkucGFyc2UuY29tIGJyZWFrcyB3aGVuIF9QdXNoU3RhdHVzIGV4aXN0cyBpbiBtb25nby5cbiAgICAgIHJldHVybiBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgIC5nZXRPbmVTY2hlbWEoY2xhc3NOYW1lLCBpc01hc3RlcilcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAvLyBCZWhhdmlvciBmb3Igbm9uLWV4aXN0ZW50IGNsYXNzZXMgaXMga2luZGEgd2VpcmQgb24gUGFyc2UuY29tLiBQcm9iYWJseSBkb2Vzbid0IG1hdHRlciB0b28gbXVjaC5cbiAgICAgICAgICAvLyBGb3Igbm93LCBwcmV0ZW5kIHRoZSBjbGFzcyBleGlzdHMgYnV0IGhhcyBubyBvYmplY3RzLFxuICAgICAgICAgIGlmIChlcnJvciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBjbGFzc0V4aXN0cyA9IGZhbHNlO1xuICAgICAgICAgICAgcmV0dXJuIHsgZmllbGRzOiB7fSB9O1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgICAgICAvLyBQYXJzZS5jb20gdHJlYXRzIHF1ZXJpZXMgb24gX2NyZWF0ZWRfYXQgYW5kIF91cGRhdGVkX2F0IGFzIGlmIHRoZXkgd2VyZSBxdWVyaWVzIG9uIGNyZWF0ZWRBdCBhbmQgdXBkYXRlZEF0LFxuICAgICAgICAgIC8vIHNvIGR1cGxpY2F0ZSB0aGF0IGJlaGF2aW9yIGhlcmUuIElmIGJvdGggYXJlIHNwZWNpZmllZCwgdGhlIGNvcnJlY3QgYmVoYXZpb3IgdG8gbWF0Y2ggUGFyc2UuY29tIGlzIHRvXG4gICAgICAgICAgLy8gdXNlIHRoZSBvbmUgdGhhdCBhcHBlYXJzIGZpcnN0IGluIHRoZSBzb3J0IGxpc3QuXG4gICAgICAgICAgaWYgKHNvcnQuX2NyZWF0ZWRfYXQpIHtcbiAgICAgICAgICAgIHNvcnQuY3JlYXRlZEF0ID0gc29ydC5fY3JlYXRlZF9hdDtcbiAgICAgICAgICAgIGRlbGV0ZSBzb3J0Ll9jcmVhdGVkX2F0O1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoc29ydC5fdXBkYXRlZF9hdCkge1xuICAgICAgICAgICAgc29ydC51cGRhdGVkQXQgPSBzb3J0Ll91cGRhdGVkX2F0O1xuICAgICAgICAgICAgZGVsZXRlIHNvcnQuX3VwZGF0ZWRfYXQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IHtcbiAgICAgICAgICAgIHNraXAsXG4gICAgICAgICAgICBsaW1pdCxcbiAgICAgICAgICAgIHNvcnQsXG4gICAgICAgICAgICBrZXlzLFxuICAgICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgICBoaW50LFxuICAgICAgICAgICAgY2FzZUluc2Vuc2l0aXZlOiB0aGlzLm9wdGlvbnMuZW5hYmxlQ29sbGF0aW9uQ2FzZUNvbXBhcmlzb24gPyBmYWxzZSA6IGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgICAgICAgIGV4cGxhaW4sXG4gICAgICAgICAgICBjb21tZW50LFxuICAgICAgICAgIH07XG4gICAgICAgICAgT2JqZWN0LmtleXMoc29ydCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZS5tYXRjaCgvXmF1dGhEYXRhXFwuKFthLXpBLVowLTlfXSspXFwuaWQkLykpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsIGBDYW5ub3Qgc29ydCBieSAke2ZpZWxkTmFtZX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHJvb3RGaWVsZE5hbWUgPSBnZXRSb290RmllbGROYW1lKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICBpZiAoIVNjaGVtYUNvbnRyb2xsZXIuZmllbGROYW1lSXNWYWxpZChyb290RmllbGROYW1lLCBjbGFzc05hbWUpKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgICAgICAgICAgIGBJbnZhbGlkIGZpZWxkIG5hbWU6ICR7ZmllbGROYW1lfS5gXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIXNjaGVtYS5maWVsZHNbZmllbGROYW1lLnNwbGl0KCcuJylbMF1dICYmIGZpZWxkTmFtZSAhPT0gJ3Njb3JlJykge1xuICAgICAgICAgICAgICBkZWxldGUgc29ydFtmaWVsZE5hbWVdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybiAoaXNNYXN0ZXJcbiAgICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICAgIDogc2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgb3ApXG4gICAgICAgICAgKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgICAgICAgdGhpcy5yZWR1Y2VSZWxhdGlvbktleXMoXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgIHF1ZXJ5T3B0aW9ucyxcbiAgICAgICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgICAgIGlzTWFzdGVyLFxuICAgICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXJcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4gdGhpcy5yZWR1Y2VJblJlbGF0aW9uKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYUNvbnRyb2xsZXIpKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICBsZXQgcHJvdGVjdGVkRmllbGRzO1xuICAgICAgICAgICAgICBpZiAoIWlzTWFzdGVyKSB7XG4gICAgICAgICAgICAgICAgcXVlcnkgPSB0aGlzLmFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICAgICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgYWNsR3JvdXBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIC8qIERvbid0IHVzZSBwcm9qZWN0aW9ucyB0byBvcHRpbWl6ZSB0aGUgcHJvdGVjdGVkRmllbGRzIHNpbmNlIHRoZSBwcm90ZWN0ZWRGaWVsZHNcbiAgICAgICAgICAgICAgICAgIGJhc2VkIG9uIHBvaW50ZXItcGVybWlzc2lvbnMgYXJlIGRldGVybWluZWQgYWZ0ZXIgcXVlcnlpbmcuIFRoZSBmaWx0ZXJpbmcgY2FuXG4gICAgICAgICAgICAgICAgICBvdmVyd3JpdGUgdGhlIHByb3RlY3RlZCBmaWVsZHMuICovXG4gICAgICAgICAgICAgICAgcHJvdGVjdGVkRmllbGRzID0gdGhpcy5hZGRQcm90ZWN0ZWRGaWVsZHMoXG4gICAgICAgICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyLFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgICAgICAgICBxdWVyeU9wdGlvbnNcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgICAgICBpZiAob3AgPT09ICdnZXQnKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQuJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICAgICAgICAgIGlmIChvcCA9PT0gJ3VwZGF0ZScgfHwgb3AgPT09ICdkZWxldGUnKSB7XG4gICAgICAgICAgICAgICAgICBxdWVyeSA9IGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2xHcm91cCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5ID0gYWRkUmVhZEFDTChxdWVyeSwgYWNsR3JvdXApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB2YWxpZGF0ZVF1ZXJ5KHF1ZXJ5LCBpc01hc3RlciwgaXNNYWludGVuYW5jZSwgZmFsc2UsIHRoaXMub3B0aW9ucyk7XG4gICAgICAgICAgICAgIGlmIChjb3VudCkge1xuICAgICAgICAgICAgICAgIGlmICghY2xhc3NFeGlzdHMpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiAwO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmNvdW50KFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgICAgICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgICAgICAgICAgIGNvbW1lbnRcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2UgaWYgKGRpc3RpbmN0KSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjbGFzc0V4aXN0cykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmRpc3RpbmN0KGNsYXNzTmFtZSwgc2NoZW1hLCBxdWVyeSwgZGlzdGluY3QpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBlbHNlIGlmIChwaXBlbGluZSkge1xuICAgICAgICAgICAgICAgIGlmICghY2xhc3NFeGlzdHMpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5hZ2dyZWdhdGUoXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgICBwaXBlbGluZSxcbiAgICAgICAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgICAgICAgICAgIGV4cGxhaW4sXG4gICAgICAgICAgICAgICAgICAgIGNvbW1lbnQsXG4gICAgICAgICAgICAgICAgICAgIHJhd1ZhbHVlcyxcbiAgICAgICAgICAgICAgICAgICAgcmF3RmllbGROYW1lc1xuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gZWxzZSBpZiAoZXhwbGFpbikge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZmluZChjbGFzc05hbWUsIHNjaGVtYSwgcXVlcnksIHF1ZXJ5T3B0aW9ucyk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlclxuICAgICAgICAgICAgICAgICAgLmZpbmQoY2xhc3NOYW1lLCBzY2hlbWEsIHF1ZXJ5LCBxdWVyeU9wdGlvbnMpXG4gICAgICAgICAgICAgICAgICAudGhlbihvYmplY3RzID0+XG4gICAgICAgICAgICAgICAgICAgIG9iamVjdHMubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgb2JqZWN0ID0gdW50cmFuc2Zvcm1PYmplY3RBQ0wob2JqZWN0KTtcbiAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmlsdGVyU2Vuc2l0aXZlRGF0YShcbiAgICAgICAgICAgICAgICAgICAgICAgIGlzTWFzdGVyLFxuICAgICAgICAgICAgICAgICAgICAgICAgaXNNYWludGVuYW5jZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9wLFxuICAgICAgICAgICAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb3RlY3RlZEZpZWxkcyxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdCxcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMub3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHNPd25lckV4ZW1wdFxuICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBQYXJzZS5FcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGRldGFpbGVkTWVzc2FnZSA9XG4gICAgICAgICAgICAgICAgICAgICAgdHlwZW9mIGVycm9yID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgICAgICAgICAgICAgPyBlcnJvclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBlcnJvcj8ubWVzc2FnZSB8fCAnQW4gaW50ZXJuYWwgc2VydmVyIGVycm9yIG9jY3VycmVkJztcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAgICAgICAgICAgICAgIGRldGFpbGVkTWVzc2FnZSxcbiAgICAgICAgICAgICAgICAgICAgICB0aGlzLm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgICAgICAgJ0FuIGludGVybmFsIHNlcnZlciBlcnJvciBvY2N1cnJlZCdcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBkZWxldGVTY2hlbWEoY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsZXQgc2NoZW1hQ29udHJvbGxlcjtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKHsgY2xlYXJDYWNoZTogdHJ1ZSB9KVxuICAgICAgLnRoZW4ocyA9PiB7XG4gICAgICAgIHNjaGVtYUNvbnRyb2xsZXIgPSBzO1xuICAgICAgICByZXR1cm4gc2NoZW1hQ29udHJvbGxlci5nZXRPbmVTY2hlbWEoY2xhc3NOYW1lLCB0cnVlKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJldHVybiB7IGZpZWxkczoge30gfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICAgIC50aGVuKChzY2hlbWE6IGFueSkgPT4ge1xuICAgICAgICByZXR1cm4gdGhpcy5jb2xsZWN0aW9uRXhpc3RzKGNsYXNzTmFtZSlcbiAgICAgICAgICAudGhlbigoKSA9PiB0aGlzLmFkYXB0ZXIuY291bnQoY2xhc3NOYW1lLCB7IGZpZWxkczoge30gfSwgbnVsbCwgJycsIGZhbHNlKSlcbiAgICAgICAgICAudGhlbihjb3VudCA9PiB7XG4gICAgICAgICAgICBpZiAoY291bnQgPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAyNTUsXG4gICAgICAgICAgICAgICAgYENsYXNzICR7Y2xhc3NOYW1lfSBpcyBub3QgZW1wdHksIGNvbnRhaW5zICR7Y291bnR9IG9iamVjdHMsIGNhbm5vdCBkcm9wIHNjaGVtYS5gXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmRlbGV0ZUNsYXNzKGNsYXNzTmFtZSk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbih3YXNQYXJzZUNvbGxlY3Rpb24gPT4ge1xuICAgICAgICAgICAgaWYgKHdhc1BhcnNlQ29sbGVjdGlvbikge1xuICAgICAgICAgICAgICBjb25zdCByZWxhdGlvbkZpZWxkTmFtZXMgPSBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5maWx0ZXIoXG4gICAgICAgICAgICAgICAgZmllbGROYW1lID0+IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUmVsYXRpb24nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgICAgICAgICByZWxhdGlvbkZpZWxkTmFtZXMubWFwKG5hbWUgPT5cbiAgICAgICAgICAgICAgICAgIHRoaXMuYWRhcHRlci5kZWxldGVDbGFzcyhqb2luVGFibGVOYW1lKGNsYXNzTmFtZSwgbmFtZSkpXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICAgIFNjaGVtYUNhY2hlLmRlbChjbGFzc05hbWUpO1xuICAgICAgICAgICAgICAgIHJldHVybiBzY2hlbWFDb250cm9sbGVyLnJlbG9hZERhdGEoKTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8vIFRoaXMgaGVscHMgdG8gY3JlYXRlIGludGVybWVkaWF0ZSBvYmplY3RzIGZvciBzaW1wbGVyIGNvbXBhcmlzb24gb2ZcbiAgLy8ga2V5IHZhbHVlIHBhaXJzIHVzZWQgaW4gcXVlcnkgb2JqZWN0cy4gRWFjaCBrZXkgdmFsdWUgcGFpciB3aWxsIHJlcHJlc2VudGVkXG4gIC8vIGluIGEgc2ltaWxhciB3YXkgdG8ganNvblxuICBvYmplY3RUb0VudHJpZXNTdHJpbmdzKHF1ZXJ5OiBhbnkpOiBBcnJheTxzdHJpbmc+IHtcbiAgICByZXR1cm4gT2JqZWN0LmVudHJpZXMocXVlcnkpLm1hcChhID0+IGEubWFwKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmpvaW4oJzonKSk7XG4gIH1cblxuICAvLyBOYWl2ZSBsb2dpYyByZWR1Y2VyIGZvciBPUiBvcGVyYXRpb25zIG1lYW50IHRvIGJlIHVzZWQgb25seSBmb3IgcG9pbnRlciBwZXJtaXNzaW9ucy5cbiAgcmVkdWNlT3JPcGVyYXRpb24ocXVlcnk6IHsgJG9yOiBBcnJheTxhbnk+IH0pOiBhbnkge1xuICAgIGlmICghcXVlcnkuJG9yKSB7XG4gICAgICByZXR1cm4gcXVlcnk7XG4gICAgfVxuICAgIGNvbnN0IHF1ZXJpZXMgPSBxdWVyeS4kb3IubWFwKHEgPT4gdGhpcy5vYmplY3RUb0VudHJpZXNTdHJpbmdzKHEpKTtcbiAgICBsZXQgcmVwZWF0ID0gZmFsc2U7XG4gICAgZG8ge1xuICAgICAgcmVwZWF0ID0gZmFsc2U7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHF1ZXJpZXMubGVuZ3RoIC0gMTsgaSsrKSB7XG4gICAgICAgIGZvciAobGV0IGogPSBpICsgMTsgaiA8IHF1ZXJpZXMubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICBjb25zdCBbc2hvcnRlciwgbG9uZ2VyXSA9IHF1ZXJpZXNbaV0ubGVuZ3RoID4gcXVlcmllc1tqXS5sZW5ndGggPyBbaiwgaV0gOiBbaSwgal07XG4gICAgICAgICAgY29uc3QgZm91bmRFbnRyaWVzID0gcXVlcmllc1tzaG9ydGVyXS5yZWR1Y2UoXG4gICAgICAgICAgICAoYWNjLCBlbnRyeSkgPT4gYWNjICsgKHF1ZXJpZXNbbG9uZ2VyXS5pbmNsdWRlcyhlbnRyeSkgPyAxIDogMCksXG4gICAgICAgICAgICAwXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25zdCBzaG9ydGVyRW50cmllcyA9IHF1ZXJpZXNbc2hvcnRlcl0ubGVuZ3RoO1xuICAgICAgICAgIGlmIChmb3VuZEVudHJpZXMgPT09IHNob3J0ZXJFbnRyaWVzKSB7XG4gICAgICAgICAgICAvLyBJZiB0aGUgc2hvcnRlciBxdWVyeSBpcyBjb21wbGV0ZWx5IGNvbnRhaW5lZCBpbiB0aGUgbG9uZ2VyIG9uZSwgd2UgY2FuIHN0cmlrZVxuICAgICAgICAgICAgLy8gb3V0IHRoZSBsb25nZXIgcXVlcnkuXG4gICAgICAgICAgICBxdWVyeS4kb3Iuc3BsaWNlKGxvbmdlciwgMSk7XG4gICAgICAgICAgICBxdWVyaWVzLnNwbGljZShsb25nZXIsIDEpO1xuICAgICAgICAgICAgcmVwZWF0ID0gdHJ1ZTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gd2hpbGUgKHJlcGVhdCk7XG4gICAgaWYgKHF1ZXJ5LiRvci5sZW5ndGggPT09IDEpIHtcbiAgICAgIHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ucXVlcnkuJG9yWzBdIH07XG4gICAgICBkZWxldGUgcXVlcnkuJG9yO1xuICAgIH1cbiAgICByZXR1cm4gcXVlcnk7XG4gIH1cblxuICAvLyBOYWl2ZSBsb2dpYyByZWR1Y2VyIGZvciBBTkQgb3BlcmF0aW9ucyBtZWFudCB0byBiZSB1c2VkIG9ubHkgZm9yIHBvaW50ZXIgcGVybWlzc2lvbnMuXG4gIHJlZHVjZUFuZE9wZXJhdGlvbihxdWVyeTogeyAkYW5kOiBBcnJheTxhbnk+IH0pOiBhbnkge1xuICAgIGlmICghcXVlcnkuJGFuZCkge1xuICAgICAgcmV0dXJuIHF1ZXJ5O1xuICAgIH1cbiAgICBjb25zdCBxdWVyaWVzID0gcXVlcnkuJGFuZC5tYXAocSA9PiB0aGlzLm9iamVjdFRvRW50cmllc1N0cmluZ3MocSkpO1xuICAgIGxldCByZXBlYXQgPSBmYWxzZTtcbiAgICBkbyB7XG4gICAgICByZXBlYXQgPSBmYWxzZTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcXVlcmllcy5sZW5ndGggLSAxOyBpKyspIHtcbiAgICAgICAgZm9yIChsZXQgaiA9IGkgKyAxOyBqIDwgcXVlcmllcy5sZW5ndGg7IGorKykge1xuICAgICAgICAgIGNvbnN0IFtzaG9ydGVyLCBsb25nZXJdID0gcXVlcmllc1tpXS5sZW5ndGggPiBxdWVyaWVzW2pdLmxlbmd0aCA/IFtqLCBpXSA6IFtpLCBqXTtcbiAgICAgICAgICBjb25zdCBmb3VuZEVudHJpZXMgPSBxdWVyaWVzW3Nob3J0ZXJdLnJlZHVjZShcbiAgICAgICAgICAgIChhY2MsIGVudHJ5KSA9PiBhY2MgKyAocXVlcmllc1tsb25nZXJdLmluY2x1ZGVzKGVudHJ5KSA/IDEgOiAwKSxcbiAgICAgICAgICAgIDBcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnN0IHNob3J0ZXJFbnRyaWVzID0gcXVlcmllc1tzaG9ydGVyXS5sZW5ndGg7XG4gICAgICAgICAgaWYgKGZvdW5kRW50cmllcyA9PT0gc2hvcnRlckVudHJpZXMpIHtcbiAgICAgICAgICAgIC8vIElmIHRoZSBzaG9ydGVyIHF1ZXJ5IGlzIGNvbXBsZXRlbHkgY29udGFpbmVkIGluIHRoZSBsb25nZXIgb25lLCB3ZSBjYW4gc3RyaWtlXG4gICAgICAgICAgICAvLyBvdXQgdGhlIHNob3J0ZXIgcXVlcnkuXG4gICAgICAgICAgICBxdWVyeS4kYW5kLnNwbGljZShzaG9ydGVyLCAxKTtcbiAgICAgICAgICAgIHF1ZXJpZXMuc3BsaWNlKHNob3J0ZXIsIDEpO1xuICAgICAgICAgICAgcmVwZWF0ID0gdHJ1ZTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gd2hpbGUgKHJlcGVhdCk7XG4gICAgaWYgKHF1ZXJ5LiRhbmQubGVuZ3RoID09PSAxKSB7XG4gICAgICBxdWVyeSA9IHsgLi4ucXVlcnksIC4uLnF1ZXJ5LiRhbmRbMF0gfTtcbiAgICAgIGRlbGV0ZSBxdWVyeS4kYW5kO1xuICAgIH1cbiAgICByZXR1cm4gcXVlcnk7XG4gIH1cblxuICAvLyBDb25zdHJhaW50cyBxdWVyeSB1c2luZyBDTFAncyBwb2ludGVyIHBlcm1pc3Npb25zIChQUCkgaWYgYW55LlxuICAvLyAxLiBFdHJhY3QgdGhlIHVzZXIgaWQgZnJvbSBjYWxsZXIncyBBQ0xncm91cDtcbiAgLy8gMi4gRXhjdHJhY3QgYSBsaXN0IG9mIGZpZWxkIG5hbWVzIHRoYXQgYXJlIFBQIGZvciB0YXJnZXQgY29sbGVjdGlvbiBhbmQgb3BlcmF0aW9uO1xuICAvLyAzLiBDb25zdHJhaW50IHRoZSBvcmlnaW5hbCBxdWVyeSBzbyB0aGF0IGVhY2ggUFAgZmllbGQgbXVzdFxuICAvLyBwb2ludCB0byBjYWxsZXIncyBpZCAob3IgY29udGFpbiBpdCBpbiBjYXNlIG9mIFBQIGZpZWxkIGJlaW5nIGFuIGFycmF5KVxuICBhZGRQb2ludGVyUGVybWlzc2lvbnMoXG4gICAgc2NoZW1hOiBTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXIsXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgb3BlcmF0aW9uOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICBhY2xHcm91cDogYW55W10gPSBbXVxuICApOiBhbnkge1xuICAgIC8vIENoZWNrIGlmIGNsYXNzIGhhcyBwdWJsaWMgcGVybWlzc2lvbiBmb3Igb3BlcmF0aW9uXG4gICAgLy8gSWYgdGhlIEJhc2VDTFAgcGFzcywgbGV0IGdvIHRocm91Z2hcbiAgICBpZiAoc2NoZW1hLnRlc3RQZXJtaXNzaW9uc0ZvckNsYXNzTmFtZShjbGFzc05hbWUsIGFjbEdyb3VwLCBvcGVyYXRpb24pKSB7XG4gICAgICByZXR1cm4gcXVlcnk7XG4gICAgfVxuICAgIGNvbnN0IHBlcm1zID0gc2NoZW1hLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWUpO1xuXG4gICAgY29uc3QgdXNlckFDTCA9IGFjbEdyb3VwLmZpbHRlcihhY2wgPT4ge1xuICAgICAgcmV0dXJuIGFjbC5pbmRleE9mKCdyb2xlOicpICE9IDAgJiYgYWNsICE9ICcqJztcbiAgICB9KTtcblxuICAgIGNvbnN0IGdyb3VwS2V5ID1cbiAgICAgIFsnZ2V0JywgJ2ZpbmQnLCAnY291bnQnXS5pbmRleE9mKG9wZXJhdGlvbikgPiAtMSA/ICdyZWFkVXNlckZpZWxkcycgOiAnd3JpdGVVc2VyRmllbGRzJztcblxuICAgIGNvbnN0IHBlcm1GaWVsZHMgPSBbXTtcblxuICAgIGlmIChwZXJtc1tvcGVyYXRpb25dICYmIHBlcm1zW29wZXJhdGlvbl0ucG9pbnRlckZpZWxkcykge1xuICAgICAgcGVybUZpZWxkcy5wdXNoKC4uLnBlcm1zW29wZXJhdGlvbl0ucG9pbnRlckZpZWxkcyk7XG4gICAgfVxuXG4gICAgaWYgKHBlcm1zW2dyb3VwS2V5XSkge1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBvZiBwZXJtc1tncm91cEtleV0pIHtcbiAgICAgICAgaWYgKCFwZXJtRmllbGRzLmluY2x1ZGVzKGZpZWxkKSkge1xuICAgICAgICAgIHBlcm1GaWVsZHMucHVzaChmaWVsZCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgLy8gdGhlIEFDTCBzaG91bGQgaGF2ZSBleGFjdGx5IDEgdXNlclxuICAgIGlmIChwZXJtRmllbGRzLmxlbmd0aCA+IDApIHtcbiAgICAgIC8vIHRoZSBBQ0wgc2hvdWxkIGhhdmUgZXhhY3RseSAxIHVzZXJcbiAgICAgIC8vIE5vIHVzZXIgc2V0IHJldHVybiB1bmRlZmluZWRcbiAgICAgIC8vIElmIHRoZSBsZW5ndGggaXMgPiAxLCB0aGF0IG1lYW5zIHdlIGRpZG4ndCBkZS1kdXBlIHVzZXJzIGNvcnJlY3RseVxuICAgICAgaWYgKHVzZXJBQ0wubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY29uc3QgdXNlcklkID0gdXNlckFDTFswXTtcbiAgICAgIGNvbnN0IHVzZXJQb2ludGVyID0ge1xuICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICBvYmplY3RJZDogdXNlcklkLFxuICAgICAgfTtcblxuICAgICAgY29uc3QgcXVlcmllcyA9IHBlcm1GaWVsZHMubWFwKGtleSA9PiB7XG4gICAgICAgIGNvbnN0IGZpZWxkRGVzY3JpcHRvciA9IHNjaGVtYS5nZXRFeHBlY3RlZFR5cGUoY2xhc3NOYW1lLCBrZXkpO1xuICAgICAgICBjb25zdCBmaWVsZFR5cGUgPVxuICAgICAgICAgIGZpZWxkRGVzY3JpcHRvciAmJlxuICAgICAgICAgIHR5cGVvZiBmaWVsZERlc2NyaXB0b3IgPT09ICdvYmplY3QnICYmXG4gICAgICAgICAgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGZpZWxkRGVzY3JpcHRvciwgJ3R5cGUnKVxuICAgICAgICAgICAgPyBmaWVsZERlc2NyaXB0b3IudHlwZVxuICAgICAgICAgICAgOiBudWxsO1xuXG4gICAgICAgIGxldCBxdWVyeUNsYXVzZTtcblxuICAgICAgICBpZiAoZmllbGRUeXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgICAvLyBjb25zdHJhaW50IGZvciBzaW5nbGUgcG9pbnRlciBzZXR1cFxuICAgICAgICAgIHF1ZXJ5Q2xhdXNlID0geyBba2V5XTogdXNlclBvaW50ZXIgfTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZFR5cGUgPT09ICdBcnJheScpIHtcbiAgICAgICAgICAvLyBjb25zdHJhaW50IGZvciB1c2Vycy1hcnJheSBzZXR1cFxuICAgICAgICAgIHF1ZXJ5Q2xhdXNlID0geyBba2V5XTogeyAkYWxsOiBbdXNlclBvaW50ZXJdIH0gfTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZFR5cGUgPT09ICdPYmplY3QnKSB7XG4gICAgICAgICAgLy8gY29uc3RyYWludCBmb3Igb2JqZWN0IHNldHVwXG4gICAgICAgICAgcXVlcnlDbGF1c2UgPSB7IFtrZXldOiB1c2VyUG9pbnRlciB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFRoaXMgbWVhbnMgdGhhdCB0aGVyZSBpcyBhIENMUCBmaWVsZCBvZiBhbiB1bmV4cGVjdGVkIHR5cGUuIFRoaXMgY29uZGl0aW9uIHNob3VsZCBub3QgaGFwcGVuLCB3aGljaCBpc1xuICAgICAgICAgIC8vIHdoeSBpcyBiZWluZyB0cmVhdGVkIGFzIGFuIGVycm9yLlxuICAgICAgICAgIHRocm93IEVycm9yKFxuICAgICAgICAgICAgYEFuIHVuZXhwZWN0ZWQgY29uZGl0aW9uIG9jY3VycmVkIHdoZW4gcmVzb2x2aW5nIHBvaW50ZXIgcGVybWlzc2lvbnM6ICR7Y2xhc3NOYW1lfSAke2tleX1gXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBpZiB3ZSBhbHJlYWR5IGhhdmUgYSBjb25zdHJhaW50IG9uIHRoZSBrZXksIHVzZSB0aGUgJGFuZFxuICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHF1ZXJ5LCBrZXkpKSB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlQW5kT3BlcmF0aW9uKHsgJGFuZDogW3F1ZXJ5Q2xhdXNlLCBxdWVyeV0gfSk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gb3RoZXJ3aXNlIGp1c3QgYWRkIHRoZSBjb25zdGFpbnRcbiAgICAgICAgcmV0dXJuIE9iamVjdC5hc3NpZ24oe30sIHF1ZXJ5LCBxdWVyeUNsYXVzZSk7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHF1ZXJpZXMubGVuZ3RoID09PSAxID8gcXVlcmllc1swXSA6IHRoaXMucmVkdWNlT3JPcGVyYXRpb24oeyAkb3I6IHF1ZXJpZXMgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBxdWVyeTtcbiAgICB9XG4gIH1cblxuICBhZGRQcm90ZWN0ZWRGaWVsZHMoXG4gICAgc2NoZW1hOiBTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXIgfCBhbnksXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSA9IHt9LFxuICAgIGFjbEdyb3VwOiBhbnlbXSA9IFtdLFxuICAgIGF1dGg6IGFueSA9IHt9LFxuICAgIHF1ZXJ5T3B0aW9uczogRnVsbFF1ZXJ5T3B0aW9ucyA9IHt9XG4gICk6IG51bGwgfCBzdHJpbmdbXSB7XG4gICAgY29uc3QgcGVybXMgPVxuICAgICAgc2NoZW1hICYmIHNjaGVtYS5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnNcbiAgICAgICAgPyBzY2hlbWEuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKGNsYXNzTmFtZSlcbiAgICAgICAgOiBzY2hlbWE7XG4gICAgaWYgKCFwZXJtcykgeyByZXR1cm4gbnVsbDsgfVxuXG4gICAgY29uc3QgcHJvdGVjdGVkRmllbGRzID0gcGVybXMucHJvdGVjdGVkRmllbGRzO1xuICAgIGlmICghcHJvdGVjdGVkRmllbGRzKSB7IHJldHVybiBudWxsOyB9XG5cbiAgICBpZiAoY2xhc3NOYW1lID09PSAnX1VzZXInICYmIHRoaXMub3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHNPd25lckV4ZW1wdCAhPT0gZmFsc2UgJiYgYWNsR3JvdXAuaW5kZXhPZihxdWVyeS5vYmplY3RJZCkgPiAtMSkgeyByZXR1cm4gbnVsbDsgfVxuXG4gICAgLy8gZm9yIHF1ZXJpZXMgd2hlcmUgXCJrZXlzXCIgYXJlIHNldCBhbmQgZG8gbm90IGluY2x1ZGUgYWxsICd1c2VyRmllbGQnOntmaWVsZH0sXG4gICAgLy8gd2UgaGF2ZSB0byB0cmFuc3BhcmVudGx5IGluY2x1ZGUgaXQsIGFuZCB0aGVuIHJlbW92ZSBiZWZvcmUgcmV0dXJuaW5nIHRvIGNsaWVudFxuICAgIC8vIEJlY2F1c2UgaWYgc3VjaCBrZXkgbm90IHByb2plY3RlZCB0aGUgcGVybWlzc2lvbiB3b24ndCBiZSBlbmZvcmNlZCBwcm9wZXJseVxuICAgIC8vIFBTIHRoaXMgaXMgY2FsbGVkIHdoZW4gJ2V4Y2x1ZGVLZXlzJyBhbHJlYWR5IHJlZHVjZWQgdG8gJ2tleXMnXG4gICAgY29uc3QgcHJlc2VydmVLZXlzID0gcXVlcnlPcHRpb25zLmtleXM7XG5cbiAgICAvLyB0aGVzZSBhcmUga2V5cyB0aGF0IG5lZWQgdG8gYmUgaW5jbHVkZWQgb25seVxuICAgIC8vIHRvIGJlIGFibGUgdG8gYXBwbHkgcHJvdGVjdGVkRmllbGRzIGJ5IHBvaW50ZXJcbiAgICAvLyBhbmQgdGhlbiB1bnNldCBiZWZvcmUgcmV0dXJuaW5nIHRvIGNsaWVudCAobGF0ZXIgaW4gIGZpbHRlclNlbnNpdGl2ZUZpZWxkcylcbiAgICBjb25zdCBzZXJ2ZXJPbmx5S2V5cyA9IFtdO1xuXG4gICAgY29uc3QgYXV0aGVudGljYXRlZCA9IGF1dGgudXNlcjtcblxuICAgIC8vIG1hcCB0byBhbGxvdyBjaGVjayB3aXRob3V0IGFycmF5IHNlYXJjaFxuICAgIGNvbnN0IHJvbGVzID0gKGF1dGgudXNlclJvbGVzIHx8IFtdKS5yZWR1Y2UoKGFjYywgcikgPT4ge1xuICAgICAgYWNjW3JdID0gcHJvdGVjdGVkRmllbGRzW3JdO1xuICAgICAgcmV0dXJuIGFjYztcbiAgICB9LCB7fSk7XG5cbiAgICAvLyBhcnJheSBvZiBzZXRzIG9mIHByb3RlY3RlZCBmaWVsZHMuIHNlcGFyYXRlIGl0ZW0gZm9yIGVhY2ggYXBwbGljYWJsZSBjcml0ZXJpYVxuICAgIGNvbnN0IHByb3RlY3RlZEtleXNTZXRzID0gW107XG5cbiAgICBmb3IgKGNvbnN0IGtleSBpbiBwcm90ZWN0ZWRGaWVsZHMpIHtcbiAgICAgIC8vIHNraXAgdXNlckZpZWxkc1xuICAgICAgaWYgKGtleS5zdGFydHNXaXRoKCd1c2VyRmllbGQ6JykpIHtcbiAgICAgICAgaWYgKHByZXNlcnZlS2V5cykge1xuICAgICAgICAgIGNvbnN0IGZpZWxkTmFtZSA9IGtleS5zdWJzdHJpbmcoMTApO1xuICAgICAgICAgIGlmICghcHJlc2VydmVLZXlzLmluY2x1ZGVzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgIC8vIDEuIHB1dCBpdCB0aGVyZSB0ZW1wb3JhcmlseVxuICAgICAgICAgICAgcXVlcnlPcHRpb25zLmtleXMgJiYgcXVlcnlPcHRpb25zLmtleXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgLy8gMi4gcHJlc2VydmUgaXQgZGVsZXRlIGxhdGVyXG4gICAgICAgICAgICBzZXJ2ZXJPbmx5S2V5cy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBhZGQgcHVibGljIHRpZXJcbiAgICAgIGlmIChrZXkgPT09ICcqJykge1xuICAgICAgICBwcm90ZWN0ZWRLZXlzU2V0cy5wdXNoKHByb3RlY3RlZEZpZWxkc1trZXldKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmIChhdXRoZW50aWNhdGVkKSB7XG4gICAgICAgIGlmIChrZXkgPT09ICdhdXRoZW50aWNhdGVkJykge1xuICAgICAgICAgIC8vIGZvciBsb2dnZWQgaW4gdXNlcnNcbiAgICAgICAgICBwcm90ZWN0ZWRLZXlzU2V0cy5wdXNoKHByb3RlY3RlZEZpZWxkc1trZXldKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyb2xlc1trZXldICYmIGtleS5zdGFydHNXaXRoKCdyb2xlOicpKSB7XG4gICAgICAgICAgLy8gYWRkIGFwcGxpY2FibGUgcm9sZXNcbiAgICAgICAgICBwcm90ZWN0ZWRLZXlzU2V0cy5wdXNoKHJvbGVzW2tleV0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gY2hlY2sgaWYgdGhlcmUncyBhIHJ1bGUgZm9yIGN1cnJlbnQgdXNlcidzIGlkXG4gICAgaWYgKGF1dGhlbnRpY2F0ZWQpIHtcbiAgICAgIGNvbnN0IHVzZXJJZCA9IGF1dGgudXNlci5pZDtcbiAgICAgIGlmIChwZXJtcy5wcm90ZWN0ZWRGaWVsZHNbdXNlcklkXSkge1xuICAgICAgICBwcm90ZWN0ZWRLZXlzU2V0cy5wdXNoKHBlcm1zLnByb3RlY3RlZEZpZWxkc1t1c2VySWRdKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBwcmVzZXJ2ZSBmaWVsZHMgdG8gYmUgcmVtb3ZlZCBiZWZvcmUgc2VuZGluZyByZXNwb25zZSB0byBjbGllbnRcbiAgICBpZiAoc2VydmVyT25seUtleXMubGVuZ3RoID4gMCkge1xuICAgICAgcGVybXMucHJvdGVjdGVkRmllbGRzLnRlbXBvcmFyeUtleXMgPSBzZXJ2ZXJPbmx5S2V5cztcbiAgICB9XG5cbiAgICBsZXQgcHJvdGVjdGVkS2V5cyA9IHByb3RlY3RlZEtleXNTZXRzLnJlZHVjZSgoYWNjLCBuZXh0KSA9PiB7XG4gICAgICBpZiAobmV4dCkge1xuICAgICAgICBhY2MucHVzaCguLi5uZXh0KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBhY2M7XG4gICAgfSwgW10pO1xuXG4gICAgLy8gaW50ZXJzZWN0IGFsbCBzZXRzIG9mIHByb3RlY3RlZEZpZWxkc1xuICAgIHByb3RlY3RlZEtleXNTZXRzLmZvckVhY2goZmllbGRzID0+IHtcbiAgICAgIGlmIChmaWVsZHMpIHtcbiAgICAgICAgcHJvdGVjdGVkS2V5cyA9IHByb3RlY3RlZEtleXMuZmlsdGVyKHYgPT4gZmllbGRzLmluY2x1ZGVzKHYpKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBwcm90ZWN0ZWRLZXlzO1xuICB9XG5cbiAgY3JlYXRlVHJhbnNhY3Rpb25hbFNlc3Npb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlci5jcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbigpLnRoZW4odHJhbnNhY3Rpb25hbFNlc3Npb24gPT4ge1xuICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24gPSB0cmFuc2FjdGlvbmFsU2Vzc2lvbjtcbiAgICB9KTtcbiAgfVxuXG4gIGNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uKCkge1xuICAgIGlmICghdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignVGhlcmUgaXMgbm8gdHJhbnNhY3Rpb25hbCBzZXNzaW9uIHRvIGNvbW1pdCcpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uKHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uKS50aGVuKCgpID0+IHtcbiAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uID0gbnVsbDtcbiAgICB9KTtcbiAgfVxuXG4gIGFib3J0VHJhbnNhY3Rpb25hbFNlc3Npb24oKSB7XG4gICAgaWYgKCF0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGVyZSBpcyBubyB0cmFuc2FjdGlvbmFsIHNlc3Npb24gdG8gYWJvcnQnKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlci5hYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uKHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uKS50aGVuKCgpID0+IHtcbiAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uID0gbnVsbDtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFRPRE86IGNyZWF0ZSBpbmRleGVzIG9uIGZpcnN0IGNyZWF0aW9uIG9mIGEgX1VzZXIgb2JqZWN0LiBPdGhlcndpc2UgaXQncyBpbXBvc3NpYmxlIHRvXG4gIC8vIGhhdmUgYSBQYXJzZSBhcHAgd2l0aG91dCBpdCBoYXZpbmcgYSBfVXNlciBjb2xsZWN0aW9uLlxuICBhc3luYyBwZXJmb3JtSW5pdGlhbGl6YXRpb24oKSB7XG4gICAgYXdhaXQgdGhpcy5hZGFwdGVyLnBlcmZvcm1Jbml0aWFsaXphdGlvbih7XG4gICAgICBWb2xhdGlsZUNsYXNzZXNTY2hlbWFzOiBTY2hlbWFDb250cm9sbGVyLlZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMsXG4gICAgfSk7XG4gICAgY29uc3QgcmVxdWlyZWRVc2VyRmllbGRzID0ge1xuICAgICAgZmllbGRzOiB7XG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX0RlZmF1bHQsXG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX1VzZXIsXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVxdWlyZWRSb2xlRmllbGRzID0ge1xuICAgICAgZmllbGRzOiB7XG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX0RlZmF1bHQsXG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX1JvbGUsXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVxdWlyZWRJZGVtcG90ZW5jeUZpZWxkcyA9IHtcbiAgICAgIGZpZWxkczoge1xuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9EZWZhdWx0LFxuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9JZGVtcG90ZW5jeSxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBhd2FpdCB0aGlzLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYSA9PiBzY2hlbWEuZW5mb3JjZUNsYXNzRXhpc3RzKCdfVXNlcicpKTtcbiAgICBhd2FpdCB0aGlzLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYSA9PiBzY2hlbWEuZW5mb3JjZUNsYXNzRXhpc3RzKCdfUm9sZScpKTtcbiAgICBhd2FpdCB0aGlzLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYSA9PiBzY2hlbWEuZW5mb3JjZUNsYXNzRXhpc3RzKCdfSWRlbXBvdGVuY3knKSk7XG5cbiAgICBjb25zdCBkYXRhYmFzZU9wdGlvbnMgPSB0aGlzLm9wdGlvbnMuZGF0YWJhc2VPcHRpb25zIHx8IHt9O1xuXG4gICAgaWYgKGRhdGFiYXNlT3B0aW9ucy5jcmVhdGVJbmRleFVzZXJVc2VybmFtZSAhPT0gZmFsc2UpIHtcbiAgICAgIGF3YWl0IHRoaXMuYWRhcHRlci5lbnN1cmVVbmlxdWVuZXNzKCdfVXNlcicsIHJlcXVpcmVkVXNlckZpZWxkcywgWyd1c2VybmFtZSddKS5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gZW5zdXJlIHVuaXF1ZW5lc3MgZm9yIHVzZXJuYW1lczogJywgZXJyb3IpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5vcHRpb25zLmVuYWJsZUNvbGxhdGlvbkNhc2VDb21wYXJpc29uKSB7XG4gICAgICBpZiAoZGF0YWJhc2VPcHRpb25zLmNyZWF0ZUluZGV4VXNlclVzZXJuYW1lQ2FzZUluc2Vuc2l0aXZlICE9PSBmYWxzZSkge1xuICAgICAgICBhd2FpdCB0aGlzLmFkYXB0ZXJcbiAgICAgICAgICAuZW5zdXJlSW5kZXgoJ19Vc2VyJywgcmVxdWlyZWRVc2VyRmllbGRzLCBbJ3VzZXJuYW1lJ10sICdjYXNlX2luc2Vuc2l0aXZlX3VzZXJuYW1lJywgdHJ1ZSlcbiAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgbG9nZ2VyLndhcm4oJ1VuYWJsZSB0byBjcmVhdGUgY2FzZSBpbnNlbnNpdGl2ZSB1c2VybmFtZSBpbmRleDogJywgZXJyb3IpO1xuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChkYXRhYmFzZU9wdGlvbnMuY3JlYXRlSW5kZXhVc2VyRW1haWxDYXNlSW5zZW5zaXRpdmUgIT09IGZhbHNlKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuYWRhcHRlclxuICAgICAgICAgIC5lbnN1cmVJbmRleCgnX1VzZXInLCByZXF1aXJlZFVzZXJGaWVsZHMsIFsnZW1haWwnXSwgJ2Nhc2VfaW5zZW5zaXRpdmVfZW1haWwnLCB0cnVlKVxuICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICBsb2dnZXIud2FybignVW5hYmxlIHRvIGNyZWF0ZSBjYXNlIGluc2Vuc2l0aXZlIGVtYWlsIGluZGV4OiAnLCBlcnJvcik7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZGF0YWJhc2VPcHRpb25zLmNyZWF0ZUluZGV4VXNlckVtYWlsICE9PSBmYWxzZSkge1xuICAgICAgYXdhaXQgdGhpcy5hZGFwdGVyLmVuc3VyZVVuaXF1ZW5lc3MoJ19Vc2VyJywgcmVxdWlyZWRVc2VyRmllbGRzLCBbJ2VtYWlsJ10pLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgbG9nZ2VyLndhcm4oJ1VuYWJsZSB0byBlbnN1cmUgdW5pcXVlbmVzcyBmb3IgdXNlciBlbWFpbCBhZGRyZXNzZXM6ICcsIGVycm9yKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAoZGF0YWJhc2VPcHRpb25zLmNyZWF0ZUluZGV4VXNlckVtYWlsVmVyaWZ5VG9rZW4gIT09IGZhbHNlKSB7XG4gICAgICBhd2FpdCB0aGlzLmFkYXB0ZXJcbiAgICAgICAgLmVuc3VyZUluZGV4KCdfVXNlcicsIHJlcXVpcmVkVXNlckZpZWxkcywgWydfZW1haWxfdmVyaWZ5X3Rva2VuJ10sICdfZW1haWxfdmVyaWZ5X3Rva2VuJywgZmFsc2UpXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgbG9nZ2VyLndhcm4oJ1VuYWJsZSB0byBjcmVhdGUgaW5kZXggZm9yIGVtYWlsIHZlcmlmaWNhdGlvbiB0b2tlbjogJywgZXJyb3IpO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAoZGF0YWJhc2VPcHRpb25zLmNyZWF0ZUluZGV4VXNlclBhc3N3b3JkUmVzZXRUb2tlbiAhPT0gZmFsc2UpIHtcbiAgICAgIGF3YWl0IHRoaXMuYWRhcHRlclxuICAgICAgICAuZW5zdXJlSW5kZXgoJ19Vc2VyJywgcmVxdWlyZWRVc2VyRmllbGRzLCBbJ19wZXJpc2hhYmxlX3Rva2VuJ10sICdfcGVyaXNoYWJsZV90b2tlbicsIGZhbHNlKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gY3JlYXRlIGluZGV4IGZvciBwYXNzd29yZCByZXNldCB0b2tlbjogJywgZXJyb3IpO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAoZGF0YWJhc2VPcHRpb25zLmNyZWF0ZUluZGV4Um9sZU5hbWUgIT09IGZhbHNlKSB7XG4gICAgICBhd2FpdCB0aGlzLmFkYXB0ZXIuZW5zdXJlVW5pcXVlbmVzcygnX1JvbGUnLCByZXF1aXJlZFJvbGVGaWVsZHMsIFsnbmFtZSddKS5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gZW5zdXJlIHVuaXF1ZW5lc3MgZm9yIHJvbGUgbmFtZTogJywgZXJyb3IpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMuYWRhcHRlclxuICAgICAgLmVuc3VyZVVuaXF1ZW5lc3MoJ19JZGVtcG90ZW5jeScsIHJlcXVpcmVkSWRlbXBvdGVuY3lGaWVsZHMsIFsncmVxSWQnXSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gZW5zdXJlIHVuaXF1ZW5lc3MgZm9yIGlkZW1wb3RlbmN5IHJlcXVlc3QgSUQ6ICcsIGVycm9yKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcblxuICAgIGNvbnN0IGlzTW9uZ29BZGFwdGVyID0gdGhpcy5hZGFwdGVyIGluc3RhbmNlb2YgTW9uZ29TdG9yYWdlQWRhcHRlcjtcbiAgICBjb25zdCBpc1Bvc3RncmVzQWRhcHRlciA9IHRoaXMuYWRhcHRlciBpbnN0YW5jZW9mIFBvc3RncmVzU3RvcmFnZUFkYXB0ZXI7XG4gICAgaWYgKGlzTW9uZ29BZGFwdGVyIHx8IGlzUG9zdGdyZXNBZGFwdGVyKSB7XG4gICAgICBsZXQgb3B0aW9ucyA9IHt9O1xuICAgICAgaWYgKGlzTW9uZ29BZGFwdGVyKSB7XG4gICAgICAgIG9wdGlvbnMgPSB7XG4gICAgICAgICAgdHRsOiAwLFxuICAgICAgICB9O1xuICAgICAgfSBlbHNlIGlmIChpc1Bvc3RncmVzQWRhcHRlcikge1xuICAgICAgICBvcHRpb25zID0gdGhpcy5pZGVtcG90ZW5jeU9wdGlvbnM7XG4gICAgICAgIG9wdGlvbnMuc2V0SWRlbXBvdGVuY3lGdW5jdGlvbiA9IHRydWU7XG4gICAgICB9XG4gICAgICBhd2FpdCB0aGlzLmFkYXB0ZXJcbiAgICAgICAgLmVuc3VyZUluZGV4KCdfSWRlbXBvdGVuY3knLCByZXF1aXJlZElkZW1wb3RlbmN5RmllbGRzLCBbJ2V4cGlyZSddLCAndHRsJywgZmFsc2UsIG9wdGlvbnMpXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgbG9nZ2VyLndhcm4oJ1VuYWJsZSB0byBjcmVhdGUgVFRMIGluZGV4IGZvciBpZGVtcG90ZW5jeSBleHBpcmUgZGF0ZTogJywgZXJyb3IpO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgLy8gQ3JlYXRlIHVuaXF1ZSBpbmRleGVzIGZvciBhdXRoRGF0YSBwcm92aWRlcnMgdG8gcHJldmVudCByYWNlIGNvbmRpdGlvbnNcbiAgICAvLyBkdXJpbmcgY29uY3VycmVudCBzaWdudXBzIHdpdGggdGhlIHNhbWUgYXV0aERhdGFcbiAgICBpZiAoXG4gICAgICBkYXRhYmFzZU9wdGlvbnMuY3JlYXRlSW5kZXhBdXRoRGF0YVVuaXF1ZW5lc3MgIT09IGZhbHNlICYmXG4gICAgICB0eXBlb2YgdGhpcy5hZGFwdGVyLmVuc3VyZUF1dGhEYXRhVW5pcXVlbmVzcyA9PT0gJ2Z1bmN0aW9uJ1xuICAgICkge1xuICAgICAgY29uc3QgYXV0aFByb3ZpZGVycyA9IE9iamVjdC5rZXlzKHRoaXMub3B0aW9ucy5hdXRoIHx8IHt9KTtcbiAgICAgIGlmICh0aGlzLm9wdGlvbnMuZW5hYmxlQW5vbnltb3VzVXNlcnMgIT09IGZhbHNlKSB7XG4gICAgICAgIGlmICghYXV0aFByb3ZpZGVycy5pbmNsdWRlcygnYW5vbnltb3VzJykpIHtcbiAgICAgICAgICBhdXRoUHJvdmlkZXJzLnB1c2goJ2Fub255bW91cycpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgICAgYXV0aFByb3ZpZGVycy5tYXAocHJvdmlkZXIgPT5cbiAgICAgICAgICB0aGlzLmFkYXB0ZXIuZW5zdXJlQXV0aERhdGFVbmlxdWVuZXNzKHByb3ZpZGVyKS5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICBsb2dnZXIud2FybihcbiAgICAgICAgICAgICAgYFVuYWJsZSB0byBlbnN1cmUgdW5pcXVlbmVzcyBmb3IgYXV0aCBkYXRhIHByb3ZpZGVyIFwiJHtwcm92aWRlcn1cIjogYCxcbiAgICAgICAgICAgICAgZXJyb3JcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgKVxuICAgICAgKTtcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLmFkYXB0ZXIudXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMoKTtcbiAgfVxuXG4gIF9leHBhbmRSZXN1bHRPbktleVBhdGgob2JqZWN0OiBhbnksIGtleTogc3RyaW5nLCB2YWx1ZTogYW55KTogYW55IHtcbiAgICBpZiAoa2V5LmluZGV4T2YoJy4nKSA8IDApIHtcbiAgICAgIG9iamVjdFtrZXldID0gdmFsdWVba2V5XTtcbiAgICAgIHJldHVybiBvYmplY3Q7XG4gICAgfVxuICAgIGNvbnN0IHBhdGggPSBrZXkuc3BsaXQoJy4nKTtcbiAgICBjb25zdCBmaXJzdEtleSA9IHBhdGhbMF07XG4gICAgY29uc3QgbmV4dFBhdGggPSBwYXRoLnNsaWNlKDEpLmpvaW4oJy4nKTtcblxuICAgIC8vIFNjYW4gcmVxdWVzdCBkYXRhIGZvciBkZW5pZWQga2V5d29yZHNcbiAgICBpZiAodGhpcy5vcHRpb25zICYmIHRoaXMub3B0aW9ucy5yZXF1ZXN0S2V5d29yZERlbnlsaXN0KSB7XG4gICAgICAvLyBTY2FuIHJlcXVlc3QgZGF0YSBmb3IgZGVuaWVkIGtleXdvcmRzXG4gICAgICBmb3IgKGNvbnN0IGtleXdvcmQgb2YgdGhpcy5vcHRpb25zLnJlcXVlc3RLZXl3b3JkRGVueWxpc3QpIHtcbiAgICAgICAgY29uc3QgbWF0Y2ggPSBVdGlscy5vYmplY3RDb250YWluc0tleVZhbHVlKFxuICAgICAgICAgIHsgW2ZpcnN0S2V5XTogdHJ1ZSwgW25leHRQYXRoXTogdHJ1ZSB9LFxuICAgICAgICAgIGtleXdvcmQua2V5LFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSxcbiAgICAgICAgICAgIGBQcm9oaWJpdGVkIGtleXdvcmQgaW4gcmVxdWVzdCBkYXRhOiAke0pTT04uc3RyaW5naWZ5KGtleXdvcmQpfS5gXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIG9iamVjdFtmaXJzdEtleV0gPSB0aGlzLl9leHBhbmRSZXN1bHRPbktleVBhdGgoXG4gICAgICBvYmplY3RbZmlyc3RLZXldIHx8IHt9LFxuICAgICAgbmV4dFBhdGgsXG4gICAgICB2YWx1ZVtmaXJzdEtleV1cbiAgICApO1xuICAgIGRlbGV0ZSBvYmplY3Rba2V5XTtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgX3Nhbml0aXplRGF0YWJhc2VSZXN1bHQob3JpZ2luYWxPYmplY3Q6IGFueSwgcmVzdWx0OiBhbnkpOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IHJlc3BvbnNlID0ge307XG4gICAgaWYgKCFyZXN1bHQpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzcG9uc2UpO1xuICAgIH1cbiAgICBPYmplY3Qua2V5cyhvcmlnaW5hbE9iamVjdCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgY29uc3Qga2V5VXBkYXRlID0gb3JpZ2luYWxPYmplY3Rba2V5XTtcbiAgICAgIC8vIGRldGVybWluZSBpZiB0aGF0IHdhcyBhbiBvcFxuICAgICAgaWYgKFxuICAgICAgICBrZXlVcGRhdGUgJiZcbiAgICAgICAgdHlwZW9mIGtleVVwZGF0ZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAga2V5VXBkYXRlLl9fb3AgJiZcbiAgICAgICAgWydBZGQnLCAnQWRkVW5pcXVlJywgJ1JlbW92ZScsICdJbmNyZW1lbnQnLCAnU2V0T25JbnNlcnQnXS5pbmRleE9mKGtleVVwZGF0ZS5fX29wKSA+IC0xXG4gICAgICApIHtcbiAgICAgICAgLy8gb25seSB2YWxpZCBvcHMgdGhhdCBwcm9kdWNlIGFuIGFjdGlvbmFibGUgcmVzdWx0XG4gICAgICAgIC8vIHRoZSBvcCBtYXkgaGF2ZSBoYXBwZW5lZCBvbiBhIGtleXBhdGhcbiAgICAgICAgdGhpcy5fZXhwYW5kUmVzdWx0T25LZXlQYXRoKHJlc3BvbnNlLCBrZXksIHJlc3VsdCk7XG4gICAgICAgIC8vIFJldmVydCBhcnJheSB0byBvYmplY3QgY29udmVyc2lvbiBvbiBkb3Qgbm90YXRpb24gZm9yIGFycmF5cyAoZS5nLiBcImZpZWxkLjAua2V5XCIpXG4gICAgICAgIGlmIChrZXkuaW5jbHVkZXMoJy4nKSkge1xuICAgICAgICAgIGNvbnN0IFtmaWVsZCwgaW5kZXhdID0ga2V5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgY29uc3QgaXNBcnJheUluZGV4ID0gQXJyYXkuZnJvbShpbmRleCkuZXZlcnkoYyA9PiBjID49ICcwJyAmJiBjIDw9ICc5Jyk7XG4gICAgICAgICAgaWYgKGlzQXJyYXlJbmRleCAmJiBBcnJheS5pc0FycmF5KHJlc3VsdFtmaWVsZF0pICYmICFBcnJheS5pc0FycmF5KHJlc3BvbnNlW2ZpZWxkXSkpIHtcbiAgICAgICAgICAgIHJlc3BvbnNlW2ZpZWxkXSA9IHJlc3VsdFtmaWVsZF07XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShyZXNwb25zZSk7XG4gIH1cblxuICBzdGF0aWMgX3ZhbGlkYXRlUXVlcnk6IChhbnksIGJvb2xlYW4sIGJvb2xlYW4sIGJvb2xlYW4pID0+IHZvaWQ7XG4gIHN0YXRpYyBmaWx0ZXJTZW5zaXRpdmVEYXRhOiAoYm9vbGVhbiwgYm9vbGVhbiwgYW55W10sIGFueSwgYW55LCBhbnksIHN0cmluZywgYW55W10sIGFueSwgP2Jvb2xlYW4pID0+IHZvaWQ7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRGF0YWJhc2VDb250cm9sbGVyO1xuLy8gRXhwb3NlIHZhbGlkYXRlUXVlcnkgZm9yIHRlc3RzXG5tb2R1bGUuZXhwb3J0cy5fdmFsaWRhdGVRdWVyeSA9IHZhbGlkYXRlUXVlcnk7XG5tb2R1bGUuZXhwb3J0cy5maWx0ZXJTZW5zaXRpdmVEYXRhID0gZmlsdGVyU2Vuc2l0aXZlRGF0YTtcbiJdLCJtYXBwaW5ncyI6Ijs7QUFLQSxJQUFBQSxLQUFBLEdBQUFDLE9BQUE7QUFFQSxJQUFBQyxPQUFBLEdBQUFDLHNCQUFBLENBQUFGLE9BQUE7QUFFQSxJQUFBRyxVQUFBLEdBQUFELHNCQUFBLENBQUFGLE9BQUE7QUFDQSxJQUFBSSxPQUFBLEdBQUFGLHNCQUFBLENBQUFGLE9BQUE7QUFDQSxJQUFBSyxNQUFBLEdB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