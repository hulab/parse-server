"use strict";

var _logger = _interopRequireDefault(require("../../../logger"));
var _lodash = _interopRequireDefault(require("lodash"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
var mongodb = require('mongodb');
var Parse = require('parse/node').Parse;
const Utils = require('../../../Utils');
const transformKey = (className, fieldName, schema) => {
  // Check if the schema is known since it's a built-in field.
  switch (fieldName) {
    case 'objectId':
      return '_id';
    case 'createdAt':
      return '_created_at';
    case 'updatedAt':
      return '_updated_at';
    case 'sessionToken':
      return '_session_token';
    case 'lastUsed':
      return '_last_used';
    case 'timesUsed':
      return 'times_used';
  }
  if (schema.fields[fieldName] && schema.fields[fieldName].__type == 'Pointer') {
    fieldName = '_p_' + fieldName;
  } else if (schema.fields[fieldName] && schema.fields[fieldName].type == 'Pointer') {
    fieldName = '_p_' + fieldName;
  }
  return fieldName;
};
const transformKeyValueForUpdate = (className, restKey, restValue, parseFormatSchema) => {
  // Check if the schema is known since it's a built-in field.
  var key = restKey;
  var timeField = false;
  switch (key) {
    case 'objectId':
    case '_id':
      if (['_GlobalConfig', '_GraphQLConfig'].includes(className)) {
        return {
          key: key,
          value: parseInt(restValue)
        };
      }
      key = '_id';
      break;
    case 'createdAt':
    case '_created_at':
      key = '_created_at';
      timeField = true;
      break;
    case 'updatedAt':
    case '_updated_at':
      key = '_updated_at';
      timeField = true;
      break;
    case 'sessionToken':
    case '_session_token':
      key = '_session_token';
      break;
    case 'expiresAt':
    case '_expiresAt':
      key = 'expiresAt';
      timeField = true;
      break;
    case '_email_verify_token_expires_at':
      key = '_email_verify_token_expires_at';
      timeField = true;
      break;
    case '_account_lockout_expires_at':
      key = '_account_lockout_expires_at';
      timeField = true;
      break;
    case '_failed_login_count':
      key = '_failed_login_count';
      break;
    case '_perishable_token_expires_at':
      key = '_perishable_token_expires_at';
      timeField = true;
      break;
    case '_password_changed_at':
      key = '_password_changed_at';
      timeField = true;
      break;
    case '_rperm':
    case '_wperm':
      return {
        key: key,
        value: restValue
      };
    case 'lastUsed':
    case '_last_used':
      key = '_last_used';
      timeField = true;
      break;
    case 'timesUsed':
    case 'times_used':
      key = 'times_used';
      timeField = true;
      break;
  }
  if (parseFormatSchema.fields[key] && parseFormatSchema.fields[key].type === 'Pointer' || !key.includes('.') && !parseFormatSchema.fields[key] && restValue && restValue.__type == 'Pointer' // Do not use the _p_ prefix for pointers inside nested documents
  ) {
    key = '_p_' + key;
  }

  // Handle atomic values
  var value = transformTopLevelAtom(restValue);
  if (value !== CannotTransform) {
    if (timeField && typeof value === 'string') {
      value = new Date(value);
    }
    if (restKey.indexOf('.') > 0) {
      return {
        key,
        value: restValue
      };
    }
    return {
      key,
      value
    };
  }

  // Handle arrays
  if (Array.isArray(restValue)) {
    value = restValue.map(transformInteriorValue);
    return {
      key,
      value
    };
  }

  // Handle update operators
  if (typeof restValue === 'object' && '__op' in restValue) {
    return {
      key,
      value: transformUpdateOperator(restValue, false)
    };
  }

  // Handle normal objects by recursing
  value = mapValues(restValue, transformInteriorValue);
  return {
    key,
    value
  };
};
const isRegex = value => {
  return value && Utils.isRegExp(value);
};
const isStartsWithRegex = value => {
  if (!isRegex(value)) {
    return false;
  }
  const matches = value.toString().match(/\/\^\\Q.*\\E\//);
  return !!matches;
};
const isAllValuesRegexOrNone = values => {
  if (!values || !Array.isArray(values) || values.length === 0) {
    return true;
  }
  const firstValuesIsRegex = isStartsWithRegex(values[0]);
  if (values.length === 1) {
    return firstValuesIsRegex;
  }
  for (let i = 1, length = values.length; i < length; ++i) {
    if (firstValuesIsRegex !== isStartsWithRegex(values[i])) {
      return false;
    }
  }
  return true;
};
const isAnyValueRegex = values => {
  return values.some(function (value) {
    return isRegex(value);
  });
};
const transformInteriorValue = restValue => {
  if (restValue !== null && typeof restValue === 'object' && Object.keys(restValue).some(key => key.includes('$') || key.includes('.'))) {
    throw new Parse.Error(Parse.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
  }
  // Handle atomic values
  var value = transformInteriorAtom(restValue);
  if (value !== CannotTransform) {
    if (value && typeof value === 'object') {
      if (Utils.isDate(value)) {
        return value;
      }
      if (Array.isArray(value)) {
        value = value.map(transformInteriorValue);
      } else {
        value = mapValues(value, transformInteriorValue);
      }
    }
    return value;
  }

  // Handle arrays
  if (Array.isArray(restValue)) {
    return restValue.map(transformInteriorValue);
  }

  // Handle update operators
  if (typeof restValue === 'object' && '__op' in restValue) {
    return transformUpdateOperator(restValue, true);
  }

  // Handle normal objects by recursing
  return mapValues(restValue, transformInteriorValue);
};
const valueAsDate = value => {
  if (typeof value === 'string') {
    return new Date(value);
  } else if (Utils.isDate(value)) {
    return value;
  }
  return false;
};
function transformQueryKeyValue(className, key, value, schema, count = false) {
  switch (key) {
    case 'createdAt':
      if (valueAsDate(value)) {
        return {
          key: '_created_at',
          value: valueAsDate(value)
        };
      }
      key = '_created_at';
      break;
    case 'updatedAt':
      if (valueAsDate(value)) {
        return {
          key: '_updated_at',
          value: valueAsDate(value)
        };
      }
      key = '_updated_at';
      break;
    case 'expiresAt':
      if (valueAsDate(value)) {
        return {
          key: 'expiresAt',
          value: valueAsDate(value)
        };
      }
      break;
    case '_email_verify_token_expires_at':
      if (valueAsDate(value)) {
        return {
          key: '_email_verify_token_expires_at',
          value: valueAsDate(value)
        };
      }
      break;
    case 'objectId':
      {
        if (['_GlobalConfig', '_GraphQLConfig'].includes(className)) {
          value = parseInt(value);
        }
        return {
          key: '_id',
          value
        };
      }
    case '_account_lockout_expires_at':
      if (valueAsDate(value)) {
        return {
          key: '_account_lockout_expires_at',
          value: valueAsDate(value)
        };
      }
      break;
    case '_failed_login_count':
      return {
        key,
        value
      };
    case 'sessionToken':
      return {
        key: '_session_token',
        value
      };
    case '_perishable_token_expires_at':
      if (valueAsDate(value)) {
        return {
          key: '_perishable_token_expires_at',
          value: valueAsDate(value)
        };
      }
      break;
    case '_password_changed_at':
      if (valueAsDate(value)) {
        return {
          key: '_password_changed_at',
          value: valueAsDate(value)
        };
      }
      break;
    case '_rperm':
    case '_wperm':
    case '_perishable_token':
    case '_email_verify_token':
      return {
        key,
        value
      };
    case '$or':
    case '$and':
    case '$nor':
      return {
        key: key,
        value: value.map(subQuery => transformWhere(className, subQuery, schema, count))
      };
    case 'lastUsed':
      if (valueAsDate(value)) {
        return {
          key: '_last_used',
          value: valueAsDate(value)
        };
      }
      key = '_last_used';
      break;
    case 'timesUsed':
      return {
        key: 'times_used',
        value: value
      };
    default:
      {
        // Other auth data
        const authDataMatch = key.match(/^authData\.([a-zA-Z0-9_]+)(\.(.+))?$/);
        if (authDataMatch && className === '_User') {
          const provider = authDataMatch[1];
          const subField = authDataMatch[3];
          return {
            key: `_auth_data_${provider}${subField ? `.${subField}` : ''}`,
            value
          };
        }
      }
  }
  const expectedTypeIsArray = schema && schema.fields[key] && schema.fields[key].type === 'Array';
  const expectedTypeIsPointer = schema && schema.fields[key] && schema.fields[key].type === 'Pointer';
  const field = schema && schema.fields[key];
  if (expectedTypeIsPointer || !schema && !key.includes('.') && value && value.__type === 'Pointer') {
    key = '_p_' + key;
  }

  // Handle query constraints
  const transformedConstraint = transformConstraint(value, field, key, count);
  if (transformedConstraint !== CannotTransform) {
    if (transformedConstraint.$text) {
      return {
        key: '$text',
        value: transformedConstraint.$text
      };
    }
    if (transformedConstraint.$elemMatch) {
      return {
        key: '$nor',
        value: [{
          [key]: transformedConstraint
        }]
      };
    }
    return {
      key,
      value: transformedConstraint
    };
  }
  if (expectedTypeIsArray && !Array.isArray(value)) {
    return {
      key,
      value: {
        $all: [transformInteriorAtom(value)]
      }
    };
  }

  // Handle atomic values
  const transformRes = key.includes('.') ? transformInteriorAtom(value) : transformTopLevelAtom(value);
  if (transformRes !== CannotTransform) {
    return {
      key,
      value: transformRes
    };
  } else {
    throw new Parse.Error(Parse.Error.INVALID_JSON, `You cannot use ${value} as a query parameter.`);
  }
}

// Main exposed method to help run queries.
// restWhere is the "where" clause in REST API form.
// Returns the mongo form of the query.
function transformWhere(className, restWhere, schema, count = false) {
  const mongoWhere = {};
  for (const restKey in restWhere) {
    const out = transformQueryKeyValue(className, restKey, restWhere[restKey], schema, count);
    mongoWhere[out.key] = out.value;
  }
  return mongoWhere;
}
const parseObjectKeyValueToMongoObjectKeyValue = (restKey, restValue, schema) => {
  // Check if the schema is known since it's a built-in field.
  let transformedValue;
  let coercedToDate;
  switch (restKey) {
    case 'objectId':
      return {
        key: '_id',
        value: restValue
      };
    case 'expiresAt':
      transformedValue = transformTopLevelAtom(restValue);
      coercedToDate = typeof transformedValue === 'string' ? new Date(transformedValue) : transformedValue;
      return {
        key: 'expiresAt',
        value: coercedToDate
      };
    case '_email_verify_token_expires_at':
      transformedValue = transformTopLevelAtom(restValue);
      coercedToDate = typeof transformedValue === 'string' ? new Date(transformedValue) : transformedValue;
      return {
        key: '_email_verify_token_expires_at',
        value: coercedToDate
      };
    case '_account_lockout_expires_at':
      transformedValue = transformTopLevelAtom(restValue);
      coercedToDate = typeof transformedValue === 'string' ? new Date(transformedValue) : transformedValue;
      return {
        key: '_account_lockout_expires_at',
        value: coercedToDate
      };
    case '_perishable_token_expires_at':
      transformedValue = transformTopLevelAtom(restValue);
      coercedToDate = typeof transformedValue === 'string' ? new Date(transformedValue) : transformedValue;
      return {
        key: '_perishable_token_expires_at',
        value: coercedToDate
      };
    case '_password_changed_at':
      transformedValue = transformTopLevelAtom(restValue);
      coercedToDate = typeof transformedValue === 'string' ? new Date(transformedValue) : transformedValue;
      return {
        key: '_password_changed_at',
        value: coercedToDate
      };
    case '_failed_login_count':
    case '_rperm':
    case '_wperm':
    case '_email_verify_token':
    case '_hashed_password':
    case '_perishable_token':
      return {
        key: restKey,
        value: restValue
      };
    case 'sessionToken':
      return {
        key: '_session_token',
        value: restValue
      };
    default:
      // Auth data should have been transformed already
      if (restKey.match(/^authData\.([a-zA-Z0-9_]+)\.id$/)) {
        throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'can only query on ' + restKey);
      }
      // Trust that the auth data has been transformed and save it directly
      if (restKey.match(/^_auth_data_[a-zA-Z0-9_]+$/)) {
        return {
          key: restKey,
          value: restValue
        };
      }
  }
  //skip straight to transformTopLevelAtom for Bytes, they don't show up in the schema for some reason
  if (restValue && restValue.__type !== 'Bytes') {
    //Note: We may not know the type of a field here, as the user could be saving (null) to a field
    //That never existed before, meaning we can't infer the type.
    if (schema.fields[restKey] && schema.fields[restKey].type == 'Pointer' || restValue.__type == 'Pointer') {
      restKey = '_p_' + restKey;
    }
  }

  // Handle atomic values
  var value = transformTopLevelAtom(restValue);
  if (value !== CannotTransform) {
    return {
      key: restKey,
      value: value
    };
  }

  // ACLs are handled before this method is called
  // If an ACL key still exists here, something is wrong.
  if (restKey === 'ACL') {
    throw 'There was a problem transforming an ACL.';
  }

  // Handle arrays
  if (Array.isArray(restValue)) {
    value = restValue.map(transformInteriorValue);
    return {
      key: restKey,
      value: value
    };
  }

  // Handle normal objects by recursing
  if (Object.keys(restValue).some(key => key.includes('$') || key.includes('.'))) {
    throw new Parse.Error(Parse.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
  }
  value = mapValues(restValue, transformInteriorValue);
  return {
    key: restKey,
    value
  };
};
const parseObjectToMongoObjectForCreate = (className, restCreate, schema) => {
  restCreate = addLegacyACL(restCreate);
  const mongoCreate = {};
  for (const restKey in restCreate) {
    if (restCreate[restKey] && restCreate[restKey].__type === 'Relation') {
      continue;
    }
    const {
      key,
      value
    } = parseObjectKeyValueToMongoObjectKeyValue(restKey, restCreate[restKey], schema);
    if (value !== undefined) {
      mongoCreate[key] = value;
    }
  }

  // Use the legacy mongo format for createdAt and updatedAt
  if (mongoCreate.createdAt) {
    mongoCreate._created_at = new Date(mongoCreate.createdAt.iso || mongoCreate.createdAt);
    delete mongoCreate.createdAt;
  }
  if (mongoCreate.updatedAt) {
    mongoCreate._updated_at = new Date(mongoCreate.updatedAt.iso || mongoCreate.updatedAt);
    delete mongoCreate.updatedAt;
  }
  return mongoCreate;
};

// Main exposed method to help update old objects.
const transformUpdate = (className, restUpdate, parseFormatSchema) => {
  const mongoUpdate = {};
  const acl = addLegacyACL(restUpdate);
  if (acl._rperm || acl._wperm || acl._acl) {
    mongoUpdate.$set = {};
    if (acl._rperm) {
      mongoUpdate.$set._rperm = acl._rperm;
    }
    if (acl._wperm) {
      mongoUpdate.$set._wperm = acl._wperm;
    }
    if (acl._acl) {
      mongoUpdate.$set._acl = acl._acl;
    }
  }
  for (var restKey in restUpdate) {
    if (restUpdate[restKey] && restUpdate[restKey].__type === 'Relation') {
      continue;
    }
    var out = transformKeyValueForUpdate(className, restKey, restUpdate[restKey], parseFormatSchema);

    // If the output value is an object with any $ keys, it's an
    // operator that needs to be lifted onto the top level update
    // object.
    if (typeof out.value === 'object' && out.value !== null && out.value.__op) {
      mongoUpdate[out.value.__op] = mongoUpdate[out.value.__op] || {};
      mongoUpdate[out.value.__op][out.key] = out.value.arg;
    } else {
      mongoUpdate['$set'] = mongoUpdate['$set'] || {};
      mongoUpdate['$set'][out.key] = out.value;
    }
  }
  return mongoUpdate;
};

// Add the legacy _acl format.
const addLegacyACL = restObject => {
  const restObjectCopy = {
    ...restObject
  };
  const _acl = {};
  if (restObject._wperm) {
    restObject._wperm.forEach(entry => {
      _acl[entry] = {
        w: true
      };
    });
    restObjectCopy._acl = _acl;
  }
  if (restObject._rperm) {
    restObject._rperm.forEach(entry => {
      // Own-property check so an inherited member name is never read as the container
      if (!Object.hasOwn(_acl, entry)) {
        _acl[entry] = {
          r: true
        };
      } else {
        _acl[entry].r = true;
      }
    });
    restObjectCopy._acl = _acl;
  }
  return restObjectCopy;
};

// A sentinel value that helper transformations return when they
// cannot perform a transformation
function CannotTransform() {}
const transformInteriorAtom = atom => {
  // TODO: check validity harder for the __type-defined types
  if (typeof atom === 'object' && atom && !Utils.isDate(atom) && atom.__type === 'Pointer') {
    return {
      __type: 'Pointer',
      className: atom.className,
      objectId: atom.objectId
    };
  } else if (typeof atom === 'function' || typeof atom === 'symbol') {
    throw new Parse.Error(Parse.Error.INVALID_JSON, `cannot transform value: ${atom}`);
  } else if (DateCoder.isValidJSON(atom)) {
    return DateCoder.JSONToDatabase(atom);
  } else if (BytesCoder.isValidJSON(atom)) {
    return BytesCoder.JSONToDatabase(atom);
  } else if (typeof atom === 'object' && atom && atom.$regex !== undefined) {
    return new RegExp(atom.$regex);
  } else {
    return atom;
  }
};

// Helper function to transform an atom from REST format to Mongo format.
// An atom is anything that can't contain other expressions. So it
// includes things where objects are used to represent other
// datatypes, like pointers and dates, but it does not include objects
// or arrays with generic stuff inside.
// Raises an error if this cannot possibly be valid REST format.
// Returns CannotTransform if it's just not an atom
function transformTopLevelAtom(atom, field) {
  switch (typeof atom) {
    case 'number':
    case 'boolean':
    case 'undefined':
      return atom;
    case 'string':
      if (field && field.type === 'Pointer') {
        return `${field.targetClass}$${atom}`;
      }
      return atom;
    case 'symbol':
    case 'function':
      throw new Parse.Error(Parse.Error.INVALID_JSON, `cannot transform value: ${atom}`);
    case 'object':
      if (Utils.isDate(atom)) {
        // Technically dates are not rest format, but, it seems pretty
        // clear what they should be transformed to, so let's just do it.
        return atom;
      }
      if (atom === null) {
        return atom;
      }

      // TODO: check validity harder for the __type-defined types
      if (atom.__type == 'Pointer') {
        return `${atom.className}$${atom.objectId}`;
      }
      if (DateCoder.isValidJSON(atom)) {
        return DateCoder.JSONToDatabase(atom);
      }
      if (BytesCoder.isValidJSON(atom)) {
        return BytesCoder.JSONToDatabase(atom);
      }
      if (GeoPointCoder.isValidJSON(atom)) {
        return GeoPointCoder.JSONToDatabase(atom);
      }
      if (PolygonCoder.isValidJSON(atom)) {
        return PolygonCoder.JSONToDatabase(atom);
      }
      if (FileCoder.isValidJSON(atom)) {
        return FileCoder.JSONToDatabase(atom);
      }
      return CannotTransform;
    default:
      // I don't think typeof can ever let us get here
      throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, `really did not expect value: ${atom}`);
  }
}

// Transforms a query constraint from REST API format to Mongo format.
// A constraint is something with fields like $lt.
// If it is not a valid constraint but it could be a valid something
// else, return CannotTransform.
// inArray is whether this is an array field.
function transformConstraint(constraint, field, queryKey, count = false) {
  const inArray = field && field.type && field.type === 'Array';
  // Check wether the given key has `.`
  const isNestedKey = queryKey.indexOf('.') > -1;
  if (typeof constraint !== 'object' || !constraint) {
    return CannotTransform;
  }
  // For inArray or nested key, we need to transform the interior atom
  const transformFunction = inArray || isNestedKey ? transformInteriorAtom : transformTopLevelAtom;
  const transformer = atom => {
    const result = transformFunction(atom, field);
    if (result === CannotTransform) {
      throw new Parse.Error(Parse.Error.INVALID_JSON, `bad atom: ${JSON.stringify(atom)}`);
    }
    return result;
  };
  // keys is the constraints in reverse alphabetical order.
  // This is a hack so that:
  //   $regex is handled before $options
  //   $nearSphere is handled before $maxDistance
  var keys = Object.keys(constraint).sort().reverse();
  var answer = {};
  for (var key of keys) {
    switch (key) {
      case '$lt':
      case '$lte':
      case '$gt':
      case '$gte':
      case '$exists':
      case '$ne':
      case '$eq':
        {
          const val = constraint[key];
          if (val && typeof val === 'object' && val.$relativeTime) {
            if (field && field.type !== 'Date') {
              throw new Parse.Error(Parse.Error.INVALID_JSON, '$relativeTime can only be used with Date field');
            }
            switch (key) {
              case '$exists':
              case '$ne':
              case '$eq':
                throw new Parse.Error(Parse.Error.INVALID_JSON, '$relativeTime can only be used with the $lt, $lte, $gt, and $gte operators');
            }
            const parserResult = Utils.relativeTimeToDate(val.$relativeTime);
            if (parserResult.status === 'success') {
              answer[key] = parserResult.result;
              break;
            }
            _logger.default.info('Error while parsing relative date', parserResult);
            throw new Parse.Error(Parse.Error.INVALID_JSON, `bad $relativeTime (${key}) value. ${parserResult.info}`);
          }
          answer[key] = transformer(val);
          break;
        }
      case '$in':
      case '$nin':
        {
          const arr = constraint[key];
          if (!Array.isArray(arr)) {
            throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad ' + key + ' value');
          }
          answer[key] = _lodash.default.flatMap(arr, value => {
            return (atom => {
              if (Array.isArray(atom)) {
                return value.map(transformer);
              } else {
                return transformer(atom);
              }
            })(value);
          });
          break;
        }
      case '$all':
        {
          const arr = constraint[key];
          if (!Array.isArray(arr)) {
            throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad ' + key + ' value');
          }
          answer[key] = arr.map(transformInteriorAtom);
          const values = answer[key];
          if (isAnyValueRegex(values) && !isAllValuesRegexOrNone(values)) {
            throw new Parse.Error(Parse.Error.INVALID_JSON, 'All $all values must be of regex type or none: ' + values);
          }
          break;
        }
      case '$regex':
        var s = constraint[key];
        if (typeof s !== 'string') {
          throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad regex: ' + s);
        }
        answer[key] = s;
        break;
      case '$containedBy':
        {
          const arr = constraint[key];
          if (!Array.isArray(arr)) {
            throw new Parse.Error(Parse.Error.INVALID_JSON, `bad $containedBy: should be an array`);
          }
          answer.$elemMatch = {
            $nin: arr.map(transformer)
          };
          break;
        }
      case '$options':
        answer[key] = constraint[key];
        break;
      case '$text':
        {
          const search = constraint[key].$search;
          if (typeof search !== 'object') {
            throw new Parse.Error(Parse.Error.INVALID_JSON, `bad $text: $search, should be object`);
          }
          if (!search.$term || typeof search.$term !== 'string') {
            throw new Parse.Error(Parse.Error.INVALID_JSON, `bad $text: $term, should be string`);
          } else {
            answer[key] = {
              $search: search.$term
            };
          }
          if (search.$language && typeof search.$language !== 'string') {
            throw new Parse.Error(Parse.Error.INVALID_JSON, `bad $text: $language, should be string`);
          } else if (search.$language) {
            answer[key].$language = search.$language;
          }
          if (search.$caseSensitive && typeof search.$caseSensitive !== 'boolean') {
            throw new Parse.Error(Parse.Error.INVALID_JSON, `bad $text: $caseSensitive, should be boolean`);
          } else if (search.$caseSensitive) {
            answer[key].$caseSensitive = search.$caseSensitive;
          }
          if (search.$diacriticSensitive && typeof search.$diacriticSensitive !== 'boolean') {
            throw new Parse.Error(Parse.Error.INVALID_JSON, `bad $text: $diacriticSensitive, should be boolean`);
          } else if (search.$diacriticSensitive) {
            answer[key].$diacriticSensitive = search.$diacriticSensitive;
          }
          break;
        }
      case '$nearSphere':
        {
          const point = constraint[key];
          if (count) {
            answer.$geoWithin = {
              $centerSphere: [[point.longitude, point.latitude], constraint.$maxDistance]
            };
          } else {
            answer[key] = [point.longitude, point.latitude];
          }
          break;
        }
      case '$maxDistance':
        {
          if (count) {
            break;
          }
          answer[key] = constraint[key];
          break;
        }
      // The SDKs don't seem to use these but they are documented in the
      // REST API docs.
      case '$maxDistanceInRadians':
        answer['$maxDistance'] = constraint[key];
        break;
      case '$maxDistanceInMiles':
        answer['$maxDistance'] = constraint[key] / 3959;
        break;
      case '$maxDistanceInKilometers':
        answer['$maxDistance'] = constraint[key] / 6371;
        break;
      case '$select':
      case '$dontSelect':
        throw new Parse.Error(Parse.Error.COMMAND_UNAVAILABLE, 'the ' + key + ' constraint is not supported yet');
      case '$within':
        var box = constraint[key]['$box'];
        if (!box || box.length != 2) {
          throw new Parse.Error(Parse.Error.INVALID_JSON, 'malformatted $within arg');
        }
        answer[key] = {
          $box: [[box[0].longitude, box[0].latitude], [box[1].longitude, box[1].latitude]]
        };
        break;
      case '$geoWithin':
        {
          const polygon = constraint[key]['$polygon'];
          const centerSphere = constraint[key]['$centerSphere'];
          if (polygon !== undefined) {
            let points;
            if (typeof polygon === 'object' && polygon.__type === 'Polygon') {
              if (!polygon.coordinates || polygon.coordinates.length < 3) {
                throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoWithin value; Polygon.coordinates should contain at least 3 lon/lat pairs');
              }
              points = polygon.coordinates;
            } else if (Array.isArray(polygon)) {
              if (polygon.length < 3) {
                throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoWithin value; $polygon should contain at least 3 GeoPoints');
              }
              points = polygon;
            } else {
              throw new Parse.Error(Parse.Error.INVALID_JSON, "bad $geoWithin value; $polygon should be Polygon object or Array of Parse.GeoPoint's");
            }
            points = points.map(point => {
              if (Array.isArray(point) && point.length === 2) {
                Parse.GeoPoint._validate(point[1], point[0]);
                return point;
              }
              if (!GeoPointCoder.isValidJSON(point)) {
                throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoWithin value');
              } else {
                Parse.GeoPoint._validate(point.latitude, point.longitude);
              }
              return [point.longitude, point.latitude];
            });
            answer[key] = {
              $polygon: points
            };
          } else if (centerSphere !== undefined) {
            if (!Array.isArray(centerSphere) || centerSphere.length < 2) {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere should be an array of Parse.GeoPoint and distance');
            }
            // Get point, convert to geo point if necessary and validate
            let point = centerSphere[0];
            if (Array.isArray(point) && point.length === 2) {
              point = new Parse.GeoPoint(point[1], point[0]);
            } else if (!GeoPointCoder.isValidJSON(point)) {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere geo point invalid');
            }
            Parse.GeoPoint._validate(point.latitude, point.longitude);
            // Get distance and validate
            const distance = centerSphere[1];
            if (isNaN(distance) || distance < 0) {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere distance invalid');
            }
            answer[key] = {
              $centerSphere: [[point.longitude, point.latitude], distance]
            };
          }
          break;
        }
      case '$geoIntersects':
        {
          const point = constraint[key]['$point'];
          if (!GeoPointCoder.isValidJSON(point)) {
            throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoIntersect value; $point should be GeoPoint');
          } else {
            Parse.GeoPoint._validate(point.latitude, point.longitude);
          }
          answer[key] = {
            $geometry: {
              type: 'Point',
              coordinates: [point.longitude, point.latitude]
            }
          };
          break;
        }
      default:
        if (key.match(/^\$+/)) {
          throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad constraint: ' + key);
        }
        return CannotTransform;
    }
  }
  return answer;
}

// Transforms an update operator from REST format to mongo format.
// To be transformed, the input should have an __op field.
// If flatten is true, this will flatten operators to their static
// data format. For example, an increment of 2 would simply become a
// 2.
// The output for a non-flattened operator is a hash with __op being
// the mongo op, and arg being the argument.
// The output for a flattened operator is just a value.
// Returns undefined if this should be a no-op.

function transformUpdateOperator({
  __op,
  amount,
  objects
}, flatten) {
  switch (__op) {
    case 'Delete':
      if (flatten) {
        return undefined;
      } else {
        return {
          __op: '$unset',
          arg: ''
        };
      }
    case 'Increment':
      if (typeof amount !== 'number') {
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'incrementing must provide a number');
      }
      if (flatten) {
        return amount;
      } else {
        return {
          __op: '$inc',
          arg: amount
        };
      }
    case 'SetOnInsert':
      if (flatten) {
        return amount;
      } else {
        return {
          __op: '$setOnInsert',
          arg: amount
        };
      }
    case 'Add':
    case 'AddUnique':
      if (!Array.isArray(objects)) {
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'objects to add must be an array');
      }
      var toAdd = objects.map(transformInteriorAtom);
      if (flatten) {
        return toAdd;
      } else {
        var mongoOp = {
          Add: '$push',
          AddUnique: '$addToSet'
        }[__op];
        return {
          __op: mongoOp,
          arg: {
            $each: toAdd
          }
        };
      }
    case 'Remove':
      if (!Array.isArray(objects)) {
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'objects to remove must be an array');
      }
      var toRemove = objects.map(transformInteriorAtom);
      if (flatten) {
        return [];
      } else {
        return {
          __op: '$pullAll',
          arg: toRemove
        };
      }
    default:
      throw new Parse.Error(Parse.Error.COMMAND_UNAVAILABLE, `The ${__op} operator is not supported yet.`);
  }
}
function mapValues(object, iterator) {
  const result = {};
  Object.keys(object).forEach(key => {
    result[key] = iterator(object[key]);
  });
  return result;
}
const nestedMongoObjectToNestedParseObject = mongoObject => {
  switch (typeof mongoObject) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'undefined':
      return mongoObject;
    case 'symbol':
    case 'function':
      throw 'bad value in nestedMongoObjectToNestedParseObject';
    case 'object':
      if (mongoObject === null) {
        return null;
      }
      if (Array.isArray(mongoObject)) {
        return mongoObject.map(nestedMongoObjectToNestedParseObject);
      }
      if (Utils.isDate(mongoObject)) {
        return Parse._encode(mongoObject);
      }
      if (mongoObject instanceof mongodb.Long) {
        return mongoObject.toNumber();
      }
      if (mongoObject instanceof mongodb.Double) {
        return mongoObject.value;
      }
      if (BytesCoder.isValidDatabaseObject(mongoObject)) {
        return BytesCoder.databaseToJSON(mongoObject);
      }
      if (Object.prototype.hasOwnProperty.call(mongoObject, '__type') && mongoObject.__type == 'Date' && Utils.isDate(mongoObject.iso)) {
        mongoObject.iso = mongoObject.iso.toJSON();
        return mongoObject;
      }
      return mapValues(mongoObject, nestedMongoObjectToNestedParseObject);
    default:
      throw 'unknown js type';
  }
};
const transformPointerString = (schema, field, pointerString) => {
  const objData = pointerString.split('$');
  if (objData[0] !== schema.fields[field].targetClass) {
    throw 'pointer to incorrect className';
  }
  return {
    __type: 'Pointer',
    className: objData[0],
    objectId: objData[1]
  };
};

// Converts from a mongo-format object to a REST-format object.
// Does not strip out anything based on a lack of authentication.
const mongoObjectToParseObject = (className, mongoObject, schema) => {
  switch (typeof mongoObject) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'undefined':
      return mongoObject;
    case 'symbol':
    case 'function':
      throw 'bad value in mongoObjectToParseObject';
    case 'object':
      {
        if (mongoObject === null) {
          return null;
        }
        if (Array.isArray(mongoObject)) {
          return mongoObject.map(nestedMongoObjectToNestedParseObject);
        }
        if (Utils.isDate(mongoObject)) {
          return Parse._encode(mongoObject);
        }
        if (mongoObject instanceof mongodb.Long) {
          return mongoObject.toNumber();
        }
        if (mongoObject instanceof mongodb.Double) {
          return mongoObject.value;
        }
        if (BytesCoder.isValidDatabaseObject(mongoObject)) {
          return BytesCoder.databaseToJSON(mongoObject);
        }
        const restObject = {};
        if (mongoObject._rperm || mongoObject._wperm) {
          restObject._rperm = mongoObject._rperm || [];
          restObject._wperm = mongoObject._wperm || [];
          delete mongoObject._rperm;
          delete mongoObject._wperm;
        }
        for (var key in mongoObject) {
          switch (key) {
            case '_id':
              restObject['objectId'] = '' + mongoObject[key];
              break;
            case '_hashed_password':
              restObject._hashed_password = mongoObject[key];
              break;
            case '_acl':
              break;
            case '_email_verify_token':
            case '_perishable_token':
            case '_perishable_token_expires_at':
            case '_password_changed_at':
            case '_tombstone':
            case '_email_verify_token_expires_at':
            case '_account_lockout_expires_at':
            case '_failed_login_count':
            case '_password_history':
              // Those keys will be deleted if needed in the DB Controller
              restObject[key] = mongoObject[key];
              break;
            case '_session_token':
              restObject['sessionToken'] = mongoObject[key];
              break;
            case 'updatedAt':
            case '_updated_at':
              restObject['updatedAt'] = Parse._encode(new Date(mongoObject[key])).iso;
              break;
            case 'createdAt':
            case '_created_at':
              restObject['createdAt'] = Parse._encode(new Date(mongoObject[key])).iso;
              break;
            case 'expiresAt':
            case '_expiresAt':
              restObject['expiresAt'] = Parse._encode(new Date(mongoObject[key]));
              break;
            case 'lastUsed':
            case '_last_used':
              restObject['lastUsed'] = Parse._encode(new Date(mongoObject[key])).iso;
              break;
            case 'timesUsed':
            case 'times_used':
              restObject['timesUsed'] = mongoObject[key];
              break;
            case 'authData':
              if (className === '_User') {
                _logger.default.warn('ignoring authData in _User as this key is reserved to be synthesized of `_auth_data_*` keys');
              } else {
                restObject['authData'] = mongoObject[key];
              }
              break;
            default:
              // Check other auth data keys
              var authDataMatch = key.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
              if (authDataMatch && className === '_User') {
                var provider = authDataMatch[1];
                restObject['authData'] = restObject['authData'] || {};
                restObject['authData'][provider] = mongoObject[key];
                break;
              }
              if (key.indexOf('_p_') == 0) {
                var newKey = key.substring(3);
                if (!schema.fields[newKey]) {
                  _logger.default.info('transform.js', 'Found a pointer column not in the schema, dropping it.', className, newKey);
                  break;
                }
                if (schema.fields[newKey].type !== 'Pointer') {
                  _logger.default.info('transform.js', 'Found a pointer in a non-pointer column, dropping it.', className, key);
                  break;
                }
                if (mongoObject[key] === null) {
                  break;
                }
                restObject[newKey] = transformPointerString(schema, newKey, mongoObject[key]);
                break;
              } else if (key[0] == '_' && key != '__type') {
                // Unrecognized reserved key: drop it instead of failing the read
                _logger.default.warn('transform.js', 'Found an unexpected reserved key, dropping it.', className, key);
                break;
              } else {
                var value = mongoObject[key];
                if (schema.fields[key] && schema.fields[key].type === 'File' && FileCoder.isValidDatabaseObject(value)) {
                  restObject[key] = FileCoder.databaseToJSON(value);
                  break;
                }
                if (schema.fields[key] && schema.fields[key].type === 'GeoPoint' && GeoPointCoder.isValidDatabaseObject(value)) {
                  restObject[key] = GeoPointCoder.databaseToJSON(value);
                  break;
                }
                if (schema.fields[key] && schema.fields[key].type === 'Polygon' && PolygonCoder.isValidDatabaseObject(value)) {
                  restObject[key] = PolygonCoder.databaseToJSON(value);
                  break;
                }
                if (schema.fields[key] && schema.fields[key].type === 'Bytes' && BytesCoder.isValidDatabaseObject(value)) {
                  restObject[key] = BytesCoder.databaseToJSON(value);
                  break;
                }
              }
              restObject[key] = nestedMongoObjectToNestedParseObject(mongoObject[key]);
          }
        }
        const relationFieldNames = Object.keys(schema.fields).filter(fieldName => schema.fields[fieldName].type === 'Relation');
        const relationFields = {};
        relationFieldNames.forEach(relationFieldName => {
          relationFields[relationFieldName] = {
            __type: 'Relation',
            className: schema.fields[relationFieldName].targetClass
          };
        });
        return {
          ...restObject,
          ...relationFields
        };
      }
    default:
      throw 'unknown js type';
  }
};
var DateCoder = {
  JSONToDatabase(json) {
    return new Date(json.iso);
  },
  isValidJSON(value) {
    return typeof value === 'object' && value !== null && value.__type === 'Date';
  }
};
var BytesCoder = {
  base64Pattern: new RegExp('^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'),
  isBase64Value(object) {
    if (typeof object !== 'string') {
      return false;
    }
    return this.base64Pattern.test(object);
  },
  databaseToJSON(object) {
    let value;
    if (this.isBase64Value(object)) {
      value = object;
    } else {
      value = object.buffer.toString('base64');
    }
    return {
      __type: 'Bytes',
      base64: value
    };
  },
  isValidDatabaseObject(object) {
    return object instanceof mongodb.Binary || this.isBase64Value(object);
  },
  JSONToDatabase(json) {
    return new mongodb.Binary(Buffer.from(json.base64, 'base64'));
  },
  isValidJSON(value) {
    return typeof value === 'object' && value !== null && value.__type === 'Bytes';
  }
};
var GeoPointCoder = {
  databaseToJSON(object) {
    return {
      __type: 'GeoPoint',
      latitude: object[1],
      longitude: object[0]
    };
  },
  isValidDatabaseObject(object) {
    return Array.isArray(object) && object.length == 2;
  },
  JSONToDatabase(json) {
    return [json.longitude, json.latitude];
  },
  isValidJSON(value) {
    return typeof value === 'object' && value !== null && value.__type === 'GeoPoint';
  }
};
var PolygonCoder = {
  databaseToJSON(object) {
    // Convert lng/lat -> lat/lng
    const coords = object.coordinates[0].map(coord => {
      return [coord[1], coord[0]];
    });
    return {
      __type: 'Polygon',
      coordinates: coords
    };
  },
  isValidDatabaseObject(object) {
    const coords = object.coordinates[0];
    if (object.type !== 'Polygon' || !Array.isArray(coords)) {
      return false;
    }
    for (let i = 0; i < coords.length; i++) {
      const point = coords[i];
      if (!GeoPointCoder.isValidDatabaseObject(point)) {
        return false;
      }
      Parse.GeoPoint._validate(parseFloat(point[1]), parseFloat(point[0]));
    }
    return true;
  },
  JSONToDatabase(json) {
    let coords = json.coordinates;
    // Add first point to the end to close polygon
    if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
      coords.push(coords[0]);
    }
    const unique = coords.filter((item, index, ar) => {
      let foundIndex = -1;
      for (let i = 0; i < ar.length; i += 1) {
        const pt = ar[i];
        if (pt[0] === item[0] && pt[1] === item[1]) {
          foundIndex = i;
          break;
        }
      }
      return foundIndex === index;
    });
    if (unique.length < 3) {
      throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'GeoJSON: Loop must have at least 3 different vertices');
    }
    // Convert lat/long -> long/lat
    coords = coords.map(coord => {
      return [coord[1], coord[0]];
    });
    return {
      type: 'Polygon',
      coordinates: [coords]
    };
  },
  isValidJSON(value) {
    return typeof value === 'object' && value !== null && value.__type === 'Polygon';
  }
};
var FileCoder = {
  databaseToJSON(object) {
    return {
      __type: 'File',
      name: object
    };
  },
  isValidDatabaseObject(object) {
    return typeof object === 'string';
  },
  JSONToDatabase(json) {
    return json.name;
  },
  isValidJSON(value) {
    return typeof value === 'object' && value !== null && value.__type === 'File';
  }
};
module.exports = {
  transformKey,
  parseObjectToMongoObjectForCreate,
  transformUpdate,
  transformWhere,
  mongoObjectToParseObject,
  transformConstraint,
  transformPointerString
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbG9nZ2VyIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbG9kYXNoIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwibW9uZ29kYiIsIlBhcnNlIiwiVXRpbHMiLCJ0cmFuc2Zvcm1LZXkiLCJjbGFzc05hbWUiLCJmaWVsZE5hbWUiLCJzY2hlbWEiLCJmaWVsZHMiLCJfX3R5cGUiLCJ0eXBlIiwidHJhbnNmb3JtS2V5VmFsdWVGb3JVcGRhdGUiLCJyZXN0S2V5IiwicmVzdFZhbHVlIiwicGFyc2VGb3JtYXRTY2hlbWEiLCJrZXkiLCJ0aW1lRmllbGQiLCJpbmNsdWRlcyIsInZhbHVlIiwicGFyc2VJbnQiLCJ0cmFuc2Zvcm1Ub3BMZXZlbEF0b20iLCJDYW5ub3RUcmFuc2Zvcm0iLCJEYXRlIiwiaW5kZXhPZiIsIkFycmF5IiwiaXNBcnJheSIsIm1hcCIsInRyYW5zZm9ybUludGVyaW9yVmFsdWUiLCJ0cmFuc2Zvcm1VcGRhdGVPcGVyYXRvciIsIm1hcFZhbHVlcyIsImlzUmVnZXgiLCJpc1JlZ0V4cCIsImlzU3RhcnRzV2l0aFJlZ2V4IiwibWF0Y2hlcyIsInRvU3RyaW5nIiwibWF0Y2giLCJpc0FsbFZhbHVlc1JlZ2V4T3JOb25lIiwidmFsdWVzIiwibGVuZ3RoIiwiZmlyc3RWYWx1ZXNJc1JlZ2V4IiwiaSIsImlzQW55VmFsdWVSZWdleCIsInNvbWUiLCJPYmplY3QiLCJrZXlzIiwiRXJyb3IiLCJJTlZBTElEX05FU1RFRF9LRVkiLCJ0cmFuc2Zvcm1JbnRlcmlvckF0b20iLCJpc0RhdGUiLCJ2YWx1ZUFzRGF0ZSIsInRyYW5zZm9ybVF1ZXJ5S2V5VmFsdWUiLCJjb3VudCIsInN1YlF1ZXJ5IiwidHJhbnNmb3JtV2hlcmUiLCJhdXRoRGF0YU1hdGNoIiwicHJvdmlkZXIiLCJzdWJGaWVsZCIsImV4cGVjdGVkVHlwZUlzQXJyYXkiLCJleHBlY3RlZFR5cGVJc1BvaW50ZXIiLCJmaWVsZCIsInRyYW5zZm9ybWVkQ29uc3RyYWludCIsInRyYW5zZm9ybUNvbnN0cmFpbnQiLCIkdGV4dCIsIiRlbGVtTWF0Y2giLCIkYWxsIiwidHJhbnNmb3JtUmVzIiwiSU5WQUxJRF9KU09OIiwicmVzdFdoZXJlIiwibW9uZ29XaGVyZSIsIm91dCIsInBhcnNlT2JqZWN0S2V5VmFsdWVUb01vbmdvT2JqZWN0S2V5VmFsdWUiLCJ0cmFuc2Zvcm1lZFZhbHVlIiwiY29lcmNlZFRvRGF0ZSIsIklOVkFMSURfS0VZX05BTUUiLCJwYXJzZU9iamVjdFRvTW9uZ29PYmplY3RGb3JDcmVhdGUiLCJyZXN0Q3JlYXRlIiwiYWRkTGVnYWN5QUNMIiwibW9uZ29DcmVhdGUiLCJ1bmRlZmluZWQiLCJjcmVhdGVkQXQiLCJfY3JlYXRlZF9hdCIsImlzbyIsInVwZGF0ZWRBdCIsIl91cGRhdGVkX2F0IiwidHJhbnNmb3JtVXBkYXRlIiwicmVzdFVwZGF0ZSIsIm1vbmdvVXBkYXRlIiwiYWNsIiwiX3JwZXJtIiwiX3dwZXJtIiwiX2FjbCIsIiRzZXQiLCJfX29wIiwiYXJnIiwicmVzdE9iamVjdCIsInJlc3RPYmplY3RDb3B5IiwiZm9yRWFjaCIsImVudHJ5IiwidyIsImhhc093biIsInIiLCJhdG9tIiwib2JqZWN0SWQiLCJEYXRlQ29kZXIiLCJpc1ZhbGlkSlNPTiIsIkpTT05Ub0RhdGFiYXNlIiwiQnl0ZXNDb2RlciIsIiRyZWdleCIsIlJlZ0V4cCIsInRhcmdldENsYXNzIiwiR2VvUG9pbnRDb2RlciIsIlBvbHlnb25Db2RlciIsIkZpbGVDb2RlciIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsImNvbnN0cmFpbnQiLCJxdWVyeUtleSIsImluQXJyYXkiLCJpc05lc3RlZEtleSIsInRyYW5zZm9ybUZ1bmN0aW9uIiwidHJhbnNmb3JtZXIiLCJyZXN1bHQiLCJKU09OIiwic3RyaW5naWZ5Iiwic29ydCIsInJldmVyc2UiLCJhbnN3ZXIiLCJ2YWwiLCIkcmVsYXRpdmVUaW1lIiwicGFyc2VyUmVzdWx0IiwicmVsYXRpdmVUaW1lVG9EYXRlIiwic3RhdHVzIiwibG9nIiwiaW5mbyIsImFyciIsIl8iLCJmbGF0TWFwIiwicyIsIiRuaW4iLCJzZWFyY2giLCIkc2VhcmNoIiwiJHRlcm0iLCIkbGFuZ3VhZ2UiLCIkY2FzZVNlbnNpdGl2ZSIsIiRkaWFjcml0aWNTZW5zaXRpdmUiLCJwb2ludCIsIiRnZW9XaXRoaW4iLCIkY2VudGVyU3BoZXJlIiwibG9uZ2l0dWRlIiwibGF0aXR1ZGUiLCIkbWF4RGlzdGFuY2UiLCJDT01NQU5EX1VOQVZBSUxBQkxFIiwiYm94IiwiJGJveCIsInBvbHlnb24iLCJjZW50ZXJTcGhlcmUiLCJwb2ludHMiLCJjb29yZGluYXRlcyIsIkdlb1BvaW50IiwiX3ZhbGlkYXRlIiwiJHBvbHlnb24iLCJkaXN0YW5jZSIsImlzTmFOIiwiJGdlb21ldHJ5IiwiYW1vdW50Iiwib2JqZWN0cyIsImZsYXR0ZW4iLCJ0b0FkZCIsIm1vbmdvT3AiLCJBZGQiLCJBZGRVbmlxdWUiLCIkZWFjaCIsInRvUmVtb3ZlIiwib2JqZWN0IiwiaXRlcmF0b3IiLCJuZXN0ZWRNb25nb09iamVjdFRvTmVzdGVkUGFyc2VPYmplY3QiLCJtb25nb09iamVjdCIsIl9lbmNvZGUiLCJMb25nIiwidG9OdW1iZXIiLCJEb3VibGUiLCJpc1ZhbGlkRGF0YWJhc2VPYmplY3QiLCJkYXRhYmFzZVRvSlNPTiIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsInRvSlNPTiIsInRyYW5zZm9ybVBvaW50ZXJTdHJpbmciLCJwb2ludGVyU3RyaW5nIiwib2JqRGF0YSIsInNwbGl0IiwibW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0IiwiX2hhc2hlZF9wYXNzd29yZCIsIndhcm4iLCJuZXdLZXkiLCJzdWJzdHJpbmciLCJyZWxhdGlvbkZpZWxkTmFtZXMiLCJmaWx0ZXIiLCJyZWxhdGlvbkZpZWxkcyIsInJlbGF0aW9uRmllbGROYW1lIiwianNvbiIsImJhc2U2NFBhdHRlcm4iLCJpc0Jhc2U2NFZhbHVlIiwidGVzdCIsImJ1ZmZlciIsImJhc2U2NCIsIkJpbmFyeSIsIkJ1ZmZlciIsImZyb20iLCJjb29yZHMiLCJjb29yZCIsInBhcnNlRmxvYXQiLCJwdXNoIiwidW5pcXVlIiwiaXRlbSIsImluZGV4IiwiYXIiLCJmb3VuZEluZGV4IiwicHQiLCJuYW1lIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvVHJhbnNmb3JtLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBsb2cgZnJvbSAnLi4vLi4vLi4vbG9nZ2VyJztcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG52YXIgbW9uZ29kYiA9IHJlcXVpcmUoJ21vbmdvZGInKTtcbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKS5QYXJzZTtcbmNvbnN0IFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vVXRpbHMnKTtcblxuY29uc3QgdHJhbnNmb3JtS2V5ID0gKGNsYXNzTmFtZSwgZmllbGROYW1lLCBzY2hlbWEpID0+IHtcbiAgLy8gQ2hlY2sgaWYgdGhlIHNjaGVtYSBpcyBrbm93biBzaW5jZSBpdCdzIGEgYnVpbHQtaW4gZmllbGQuXG4gIHN3aXRjaCAoZmllbGROYW1lKSB7XG4gICAgY2FzZSAnb2JqZWN0SWQnOlxuICAgICAgcmV0dXJuICdfaWQnO1xuICAgIGNhc2UgJ2NyZWF0ZWRBdCc6XG4gICAgICByZXR1cm4gJ19jcmVhdGVkX2F0JztcbiAgICBjYXNlICd1cGRhdGVkQXQnOlxuICAgICAgcmV0dXJuICdfdXBkYXRlZF9hdCc7XG4gICAgY2FzZSAnc2Vzc2lvblRva2VuJzpcbiAgICAgIHJldHVybiAnX3Nlc3Npb25fdG9rZW4nO1xuICAgIGNhc2UgJ2xhc3RVc2VkJzpcbiAgICAgIHJldHVybiAnX2xhc3RfdXNlZCc7XG4gICAgY2FzZSAndGltZXNVc2VkJzpcbiAgICAgIHJldHVybiAndGltZXNfdXNlZCc7XG4gIH1cblxuICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5fX3R5cGUgPT0gJ1BvaW50ZXInKSB7XG4gICAgZmllbGROYW1lID0gJ19wXycgKyBmaWVsZE5hbWU7XG4gIH0gZWxzZSBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09ICdQb2ludGVyJykge1xuICAgIGZpZWxkTmFtZSA9ICdfcF8nICsgZmllbGROYW1lO1xuICB9XG5cbiAgcmV0dXJuIGZpZWxkTmFtZTtcbn07XG5cbmNvbnN0IHRyYW5zZm9ybUtleVZhbHVlRm9yVXBkYXRlID0gKGNsYXNzTmFtZSwgcmVzdEtleSwgcmVzdFZhbHVlLCBwYXJzZUZvcm1hdFNjaGVtYSkgPT4ge1xuICAvLyBDaGVjayBpZiB0aGUgc2NoZW1hIGlzIGtub3duIHNpbmNlIGl0J3MgYSBidWlsdC1pbiBmaWVsZC5cbiAgdmFyIGtleSA9IHJlc3RLZXk7XG4gIHZhciB0aW1lRmllbGQgPSBmYWxzZTtcbiAgc3dpdGNoIChrZXkpIHtcbiAgICBjYXNlICdvYmplY3RJZCc6XG4gICAgY2FzZSAnX2lkJzpcbiAgICAgIGlmIChbJ19HbG9iYWxDb25maWcnLCAnX0dyYXBoUUxDb25maWcnXS5pbmNsdWRlcyhjbGFzc05hbWUpKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2V5OiBrZXksXG4gICAgICAgICAgdmFsdWU6IHBhcnNlSW50KHJlc3RWYWx1ZSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBrZXkgPSAnX2lkJztcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ2NyZWF0ZWRBdCc6XG4gICAgY2FzZSAnX2NyZWF0ZWRfYXQnOlxuICAgICAga2V5ID0gJ19jcmVhdGVkX2F0JztcbiAgICAgIHRpbWVGaWVsZCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICBjYXNlICd1cGRhdGVkQXQnOlxuICAgIGNhc2UgJ191cGRhdGVkX2F0JzpcbiAgICAgIGtleSA9ICdfdXBkYXRlZF9hdCc7XG4gICAgICB0aW1lRmllbGQgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAnc2Vzc2lvblRva2VuJzpcbiAgICBjYXNlICdfc2Vzc2lvbl90b2tlbic6XG4gICAgICBrZXkgPSAnX3Nlc3Npb25fdG9rZW4nO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAnZXhwaXJlc0F0JzpcbiAgICBjYXNlICdfZXhwaXJlc0F0JzpcbiAgICAgIGtleSA9ICdleHBpcmVzQXQnO1xuICAgICAgdGltZUZpZWxkID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ19lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCc6XG4gICAgICBrZXkgPSAnX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0JztcbiAgICAgIHRpbWVGaWVsZCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdfYWNjb3VudF9sb2Nrb3V0X2V4cGlyZXNfYXQnOlxuICAgICAga2V5ID0gJ19hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCc7XG4gICAgICB0aW1lRmllbGQgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAnX2ZhaWxlZF9sb2dpbl9jb3VudCc6XG4gICAgICBrZXkgPSAnX2ZhaWxlZF9sb2dpbl9jb3VudCc7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0JzpcbiAgICAgIGtleSA9ICdfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0JztcbiAgICAgIHRpbWVGaWVsZCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdfcGFzc3dvcmRfY2hhbmdlZF9hdCc6XG4gICAgICBrZXkgPSAnX3Bhc3N3b3JkX2NoYW5nZWRfYXQnO1xuICAgICAgdGltZUZpZWxkID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ19ycGVybSc6XG4gICAgY2FzZSAnX3dwZXJtJzpcbiAgICAgIHJldHVybiB7IGtleToga2V5LCB2YWx1ZTogcmVzdFZhbHVlIH07XG4gICAgY2FzZSAnbGFzdFVzZWQnOlxuICAgIGNhc2UgJ19sYXN0X3VzZWQnOlxuICAgICAga2V5ID0gJ19sYXN0X3VzZWQnO1xuICAgICAgdGltZUZpZWxkID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ3RpbWVzVXNlZCc6XG4gICAgY2FzZSAndGltZXNfdXNlZCc6XG4gICAgICBrZXkgPSAndGltZXNfdXNlZCc7XG4gICAgICB0aW1lRmllbGQgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gIH1cblxuICBpZiAoXG4gICAgKHBhcnNlRm9ybWF0U2NoZW1hLmZpZWxkc1trZXldICYmIHBhcnNlRm9ybWF0U2NoZW1hLmZpZWxkc1trZXldLnR5cGUgPT09ICdQb2ludGVyJykgfHxcbiAgICAoIWtleS5pbmNsdWRlcygnLicpICYmXG4gICAgICAhcGFyc2VGb3JtYXRTY2hlbWEuZmllbGRzW2tleV0gJiZcbiAgICAgIHJlc3RWYWx1ZSAmJlxuICAgICAgcmVzdFZhbHVlLl9fdHlwZSA9PSAnUG9pbnRlcicpIC8vIERvIG5vdCB1c2UgdGhlIF9wXyBwcmVmaXggZm9yIHBvaW50ZXJzIGluc2lkZSBuZXN0ZWQgZG9jdW1lbnRzXG4gICkge1xuICAgIGtleSA9ICdfcF8nICsga2V5O1xuICB9XG5cbiAgLy8gSGFuZGxlIGF0b21pYyB2YWx1ZXNcbiAgdmFyIHZhbHVlID0gdHJhbnNmb3JtVG9wTGV2ZWxBdG9tKHJlc3RWYWx1ZSk7XG4gIGlmICh2YWx1ZSAhPT0gQ2Fubm90VHJhbnNmb3JtKSB7XG4gICAgaWYgKHRpbWVGaWVsZCAmJiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICB2YWx1ZSA9IG5ldyBEYXRlKHZhbHVlKTtcbiAgICB9XG4gICAgaWYgKHJlc3RLZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgcmV0dXJuIHsga2V5LCB2YWx1ZTogcmVzdFZhbHVlIH07XG4gICAgfVxuICAgIHJldHVybiB7IGtleSwgdmFsdWUgfTtcbiAgfVxuXG4gIC8vIEhhbmRsZSBhcnJheXNcbiAgaWYgKEFycmF5LmlzQXJyYXkocmVzdFZhbHVlKSkge1xuICAgIHZhbHVlID0gcmVzdFZhbHVlLm1hcCh0cmFuc2Zvcm1JbnRlcmlvclZhbHVlKTtcbiAgICByZXR1cm4geyBrZXksIHZhbHVlIH07XG4gIH1cblxuICAvLyBIYW5kbGUgdXBkYXRlIG9wZXJhdG9yc1xuICBpZiAodHlwZW9mIHJlc3RWYWx1ZSA9PT0gJ29iamVjdCcgJiYgJ19fb3AnIGluIHJlc3RWYWx1ZSkge1xuICAgIHJldHVybiB7IGtleSwgdmFsdWU6IHRyYW5zZm9ybVVwZGF0ZU9wZXJhdG9yKHJlc3RWYWx1ZSwgZmFsc2UpIH07XG4gIH1cblxuICAvLyBIYW5kbGUgbm9ybWFsIG9iamVjdHMgYnkgcmVjdXJzaW5nXG4gIHZhbHVlID0gbWFwVmFsdWVzKHJlc3RWYWx1ZSwgdHJhbnNmb3JtSW50ZXJpb3JWYWx1ZSk7XG4gIHJldHVybiB7IGtleSwgdmFsdWUgfTtcbn07XG5cbmNvbnN0IGlzUmVnZXggPSB2YWx1ZSA9PiB7XG4gIHJldHVybiB2YWx1ZSAmJiBVdGlscy5pc1JlZ0V4cCh2YWx1ZSk7XG59O1xuXG5jb25zdCBpc1N0YXJ0c1dpdGhSZWdleCA9IHZhbHVlID0+IHtcbiAgaWYgKCFpc1JlZ2V4KHZhbHVlKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGNvbnN0IG1hdGNoZXMgPSB2YWx1ZS50b1N0cmluZygpLm1hdGNoKC9cXC9cXF5cXFxcUS4qXFxcXEVcXC8vKTtcbiAgcmV0dXJuICEhbWF0Y2hlcztcbn07XG5cbmNvbnN0IGlzQWxsVmFsdWVzUmVnZXhPck5vbmUgPSB2YWx1ZXMgPT4ge1xuICBpZiAoIXZhbHVlcyB8fCAhQXJyYXkuaXNBcnJheSh2YWx1ZXMpIHx8IHZhbHVlcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGNvbnN0IGZpcnN0VmFsdWVzSXNSZWdleCA9IGlzU3RhcnRzV2l0aFJlZ2V4KHZhbHVlc1swXSk7XG4gIGlmICh2YWx1ZXMubGVuZ3RoID09PSAxKSB7XG4gICAgcmV0dXJuIGZpcnN0VmFsdWVzSXNSZWdleDtcbiAgfVxuXG4gIGZvciAobGV0IGkgPSAxLCBsZW5ndGggPSB2YWx1ZXMubGVuZ3RoOyBpIDwgbGVuZ3RoOyArK2kpIHtcbiAgICBpZiAoZmlyc3RWYWx1ZXNJc1JlZ2V4ICE9PSBpc1N0YXJ0c1dpdGhSZWdleCh2YWx1ZXNbaV0pKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59O1xuXG5jb25zdCBpc0FueVZhbHVlUmVnZXggPSB2YWx1ZXMgPT4ge1xuICByZXR1cm4gdmFsdWVzLnNvbWUoZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgcmV0dXJuIGlzUmVnZXgodmFsdWUpO1xuICB9KTtcbn07XG5cbmNvbnN0IHRyYW5zZm9ybUludGVyaW9yVmFsdWUgPSByZXN0VmFsdWUgPT4ge1xuICBpZiAoXG4gICAgcmVzdFZhbHVlICE9PSBudWxsICYmXG4gICAgdHlwZW9mIHJlc3RWYWx1ZSA9PT0gJ29iamVjdCcgJiZcbiAgICBPYmplY3Qua2V5cyhyZXN0VmFsdWUpLnNvbWUoa2V5ID0+IGtleS5pbmNsdWRlcygnJCcpIHx8IGtleS5pbmNsdWRlcygnLicpKVxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX05FU1RFRF9LRVksXG4gICAgICBcIk5lc3RlZCBrZXlzIHNob3VsZCBub3QgY29udGFpbiB0aGUgJyQnIG9yICcuJyBjaGFyYWN0ZXJzXCJcbiAgICApO1xuICB9XG4gIC8vIEhhbmRsZSBhdG9taWMgdmFsdWVzXG4gIHZhciB2YWx1ZSA9IHRyYW5zZm9ybUludGVyaW9yQXRvbShyZXN0VmFsdWUpO1xuICBpZiAodmFsdWUgIT09IENhbm5vdFRyYW5zZm9ybSkge1xuICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICBpZiAoVXRpbHMuaXNEYXRlKHZhbHVlKSkge1xuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICB9XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgdmFsdWUgPSB2YWx1ZS5tYXAodHJhbnNmb3JtSW50ZXJpb3JWYWx1ZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YWx1ZSA9IG1hcFZhbHVlcyh2YWx1ZSwgdHJhbnNmb3JtSW50ZXJpb3JWYWx1ZSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuXG4gIC8vIEhhbmRsZSBhcnJheXNcbiAgaWYgKEFycmF5LmlzQXJyYXkocmVzdFZhbHVlKSkge1xuICAgIHJldHVybiByZXN0VmFsdWUubWFwKHRyYW5zZm9ybUludGVyaW9yVmFsdWUpO1xuICB9XG5cbiAgLy8gSGFuZGxlIHVwZGF0ZSBvcGVyYXRvcnNcbiAgaWYgKHR5cGVvZiByZXN0VmFsdWUgPT09ICdvYmplY3QnICYmICdfX29wJyBpbiByZXN0VmFsdWUpIHtcbiAgICByZXR1cm4gdHJhbnNmb3JtVXBkYXRlT3BlcmF0b3IocmVzdFZhbHVlLCB0cnVlKTtcbiAgfVxuXG4gIC8vIEhhbmRsZSBub3JtYWwgb2JqZWN0cyBieSByZWN1cnNpbmdcbiAgcmV0dXJuIG1hcFZhbHVlcyhyZXN0VmFsdWUsIHRyYW5zZm9ybUludGVyaW9yVmFsdWUpO1xufTtcblxuY29uc3QgdmFsdWVBc0RhdGUgPSB2YWx1ZSA9PiB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIG5ldyBEYXRlKHZhbHVlKTtcbiAgfSBlbHNlIGlmIChVdGlscy5pc0RhdGUodmFsdWUpKSB7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn07XG5cbmZ1bmN0aW9uIHRyYW5zZm9ybVF1ZXJ5S2V5VmFsdWUoY2xhc3NOYW1lLCBrZXksIHZhbHVlLCBzY2hlbWEsIGNvdW50ID0gZmFsc2UpIHtcbiAgc3dpdGNoIChrZXkpIHtcbiAgICBjYXNlICdjcmVhdGVkQXQnOlxuICAgICAgaWYgKHZhbHVlQXNEYXRlKHZhbHVlKSkge1xuICAgICAgICByZXR1cm4geyBrZXk6ICdfY3JlYXRlZF9hdCcsIHZhbHVlOiB2YWx1ZUFzRGF0ZSh2YWx1ZSkgfTtcbiAgICAgIH1cbiAgICAgIGtleSA9ICdfY3JlYXRlZF9hdCc7XG4gICAgICBicmVhaztcbiAgICBjYXNlICd1cGRhdGVkQXQnOlxuICAgICAgaWYgKHZhbHVlQXNEYXRlKHZhbHVlKSkge1xuICAgICAgICByZXR1cm4geyBrZXk6ICdfdXBkYXRlZF9hdCcsIHZhbHVlOiB2YWx1ZUFzRGF0ZSh2YWx1ZSkgfTtcbiAgICAgIH1cbiAgICAgIGtleSA9ICdfdXBkYXRlZF9hdCc7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdleHBpcmVzQXQnOlxuICAgICAgaWYgKHZhbHVlQXNEYXRlKHZhbHVlKSkge1xuICAgICAgICByZXR1cm4geyBrZXk6ICdleHBpcmVzQXQnLCB2YWx1ZTogdmFsdWVBc0RhdGUodmFsdWUpIH07XG4gICAgICB9XG4gICAgICBicmVhaztcbiAgICBjYXNlICdfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQnOlxuICAgICAgaWYgKHZhbHVlQXNEYXRlKHZhbHVlKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtleTogJ19lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCcsXG4gICAgICAgICAgdmFsdWU6IHZhbHVlQXNEYXRlKHZhbHVlKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ29iamVjdElkJzoge1xuICAgICAgaWYgKFsnX0dsb2JhbENvbmZpZycsICdfR3JhcGhRTENvbmZpZyddLmluY2x1ZGVzKGNsYXNzTmFtZSkpIHtcbiAgICAgICAgdmFsdWUgPSBwYXJzZUludCh2YWx1ZSk7XG4gICAgICB9XG4gICAgICByZXR1cm4geyBrZXk6ICdfaWQnLCB2YWx1ZSB9O1xuICAgIH1cbiAgICBjYXNlICdfYWNjb3VudF9sb2Nrb3V0X2V4cGlyZXNfYXQnOlxuICAgICAgaWYgKHZhbHVlQXNEYXRlKHZhbHVlKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtleTogJ19hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCcsXG4gICAgICAgICAgdmFsdWU6IHZhbHVlQXNEYXRlKHZhbHVlKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ19mYWlsZWRfbG9naW5fY291bnQnOlxuICAgICAgcmV0dXJuIHsga2V5LCB2YWx1ZSB9O1xuICAgIGNhc2UgJ3Nlc3Npb25Ub2tlbic6XG4gICAgICByZXR1cm4geyBrZXk6ICdfc2Vzc2lvbl90b2tlbicsIHZhbHVlIH07XG4gICAgY2FzZSAnX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCc6XG4gICAgICBpZiAodmFsdWVBc0RhdGUodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2V5OiAnX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCcsXG4gICAgICAgICAgdmFsdWU6IHZhbHVlQXNEYXRlKHZhbHVlKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ19wYXNzd29yZF9jaGFuZ2VkX2F0JzpcbiAgICAgIGlmICh2YWx1ZUFzRGF0ZSh2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIHsga2V5OiAnX3Bhc3N3b3JkX2NoYW5nZWRfYXQnLCB2YWx1ZTogdmFsdWVBc0RhdGUodmFsdWUpIH07XG4gICAgICB9XG4gICAgICBicmVhaztcbiAgICBjYXNlICdfcnBlcm0nOlxuICAgIGNhc2UgJ193cGVybSc6XG4gICAgY2FzZSAnX3BlcmlzaGFibGVfdG9rZW4nOlxuICAgIGNhc2UgJ19lbWFpbF92ZXJpZnlfdG9rZW4nOlxuICAgICAgcmV0dXJuIHsga2V5LCB2YWx1ZSB9O1xuICAgIGNhc2UgJyRvcic6XG4gICAgY2FzZSAnJGFuZCc6XG4gICAgY2FzZSAnJG5vcic6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBrZXk6IGtleSxcbiAgICAgICAgdmFsdWU6IHZhbHVlLm1hcChzdWJRdWVyeSA9PiB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHN1YlF1ZXJ5LCBzY2hlbWEsIGNvdW50KSksXG4gICAgICB9O1xuICAgIGNhc2UgJ2xhc3RVc2VkJzpcbiAgICAgIGlmICh2YWx1ZUFzRGF0ZSh2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIHsga2V5OiAnX2xhc3RfdXNlZCcsIHZhbHVlOiB2YWx1ZUFzRGF0ZSh2YWx1ZSkgfTtcbiAgICAgIH1cbiAgICAgIGtleSA9ICdfbGFzdF91c2VkJztcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ3RpbWVzVXNlZCc6XG4gICAgICByZXR1cm4geyBrZXk6ICd0aW1lc191c2VkJywgdmFsdWU6IHZhbHVlIH07XG4gICAgZGVmYXVsdDoge1xuICAgICAgLy8gT3RoZXIgYXV0aCBkYXRhXG4gICAgICBjb25zdCBhdXRoRGF0YU1hdGNoID0ga2V5Lm1hdGNoKC9eYXV0aERhdGFcXC4oW2EtekEtWjAtOV9dKykoXFwuKC4rKSk/JC8pO1xuICAgICAgaWYgKGF1dGhEYXRhTWF0Y2ggJiYgY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXV0aERhdGFNYXRjaFsxXTtcbiAgICAgICAgY29uc3Qgc3ViRmllbGQgPSBhdXRoRGF0YU1hdGNoWzNdO1xuICAgICAgICByZXR1cm4geyBrZXk6IGBfYXV0aF9kYXRhXyR7cHJvdmlkZXJ9JHtzdWJGaWVsZCA/IGAuJHtzdWJGaWVsZH1gIDogJyd9YCwgdmFsdWUgfTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCBleHBlY3RlZFR5cGVJc0FycmF5ID0gc2NoZW1hICYmIHNjaGVtYS5maWVsZHNba2V5XSAmJiBzY2hlbWEuZmllbGRzW2tleV0udHlwZSA9PT0gJ0FycmF5JztcblxuICBjb25zdCBleHBlY3RlZFR5cGVJc1BvaW50ZXIgPVxuICAgIHNjaGVtYSAmJiBzY2hlbWEuZmllbGRzW2tleV0gJiYgc2NoZW1hLmZpZWxkc1trZXldLnR5cGUgPT09ICdQb2ludGVyJztcblxuICBjb25zdCBmaWVsZCA9IHNjaGVtYSAmJiBzY2hlbWEuZmllbGRzW2tleV07XG4gIGlmIChcbiAgICBleHBlY3RlZFR5cGVJc1BvaW50ZXIgfHxcbiAgICAoIXNjaGVtYSAmJiAha2V5LmluY2x1ZGVzKCcuJykgJiYgdmFsdWUgJiYgdmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpXG4gICkge1xuICAgIGtleSA9ICdfcF8nICsga2V5O1xuICB9XG5cbiAgLy8gSGFuZGxlIHF1ZXJ5IGNvbnN0cmFpbnRzXG4gIGNvbnN0IHRyYW5zZm9ybWVkQ29uc3RyYWludCA9IHRyYW5zZm9ybUNvbnN0cmFpbnQodmFsdWUsIGZpZWxkLCBrZXksIGNvdW50KTtcbiAgaWYgKHRyYW5zZm9ybWVkQ29uc3RyYWludCAhPT0gQ2Fubm90VHJhbnNmb3JtKSB7XG4gICAgaWYgKHRyYW5zZm9ybWVkQ29uc3RyYWludC4kdGV4dCkge1xuICAgICAgcmV0dXJuIHsga2V5OiAnJHRleHQnLCB2YWx1ZTogdHJhbnNmb3JtZWRDb25zdHJhaW50LiR0ZXh0IH07XG4gICAgfVxuICAgIGlmICh0cmFuc2Zvcm1lZENvbnN0cmFpbnQuJGVsZW1NYXRjaCkge1xuICAgICAgcmV0dXJuIHsga2V5OiAnJG5vcicsIHZhbHVlOiBbeyBba2V5XTogdHJhbnNmb3JtZWRDb25zdHJhaW50IH1dIH07XG4gICAgfVxuICAgIHJldHVybiB7IGtleSwgdmFsdWU6IHRyYW5zZm9ybWVkQ29uc3RyYWludCB9O1xuICB9XG5cbiAgaWYgKGV4cGVjdGVkVHlwZUlzQXJyYXkgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgcmV0dXJuIHsga2V5LCB2YWx1ZTogeyAkYWxsOiBbdHJhbnNmb3JtSW50ZXJpb3JBdG9tKHZhbHVlKV0gfSB9O1xuICB9XG5cbiAgLy8gSGFuZGxlIGF0b21pYyB2YWx1ZXNcbiAgY29uc3QgdHJhbnNmb3JtUmVzID0ga2V5LmluY2x1ZGVzKCcuJylcbiAgICA/IHRyYW5zZm9ybUludGVyaW9yQXRvbSh2YWx1ZSlcbiAgICA6IHRyYW5zZm9ybVRvcExldmVsQXRvbSh2YWx1ZSk7XG4gIGlmICh0cmFuc2Zvcm1SZXMgIT09IENhbm5vdFRyYW5zZm9ybSkge1xuICAgIHJldHVybiB7IGtleSwgdmFsdWU6IHRyYW5zZm9ybVJlcyB9O1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgIGBZb3UgY2Fubm90IHVzZSAke3ZhbHVlfSBhcyBhIHF1ZXJ5IHBhcmFtZXRlci5gXG4gICAgKTtcbiAgfVxufVxuXG4vLyBNYWluIGV4cG9zZWQgbWV0aG9kIHRvIGhlbHAgcnVuIHF1ZXJpZXMuXG4vLyByZXN0V2hlcmUgaXMgdGhlIFwid2hlcmVcIiBjbGF1c2UgaW4gUkVTVCBBUEkgZm9ybS5cbi8vIFJldHVybnMgdGhlIG1vbmdvIGZvcm0gb2YgdGhlIHF1ZXJ5LlxuZnVuY3Rpb24gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCByZXN0V2hlcmUsIHNjaGVtYSwgY291bnQgPSBmYWxzZSkge1xuICBjb25zdCBtb25nb1doZXJlID0ge307XG4gIGZvciAoY29uc3QgcmVzdEtleSBpbiByZXN0V2hlcmUpIHtcbiAgICBjb25zdCBvdXQgPSB0cmFuc2Zvcm1RdWVyeUtleVZhbHVlKGNsYXNzTmFtZSwgcmVzdEtleSwgcmVzdFdoZXJlW3Jlc3RLZXldLCBzY2hlbWEsIGNvdW50KTtcbiAgICBtb25nb1doZXJlW291dC5rZXldID0gb3V0LnZhbHVlO1xuICB9XG4gIHJldHVybiBtb25nb1doZXJlO1xufVxuXG5jb25zdCBwYXJzZU9iamVjdEtleVZhbHVlVG9Nb25nb09iamVjdEtleVZhbHVlID0gKHJlc3RLZXksIHJlc3RWYWx1ZSwgc2NoZW1hKSA9PiB7XG4gIC8vIENoZWNrIGlmIHRoZSBzY2hlbWEgaXMga25vd24gc2luY2UgaXQncyBhIGJ1aWx0LWluIGZpZWxkLlxuICBsZXQgdHJhbnNmb3JtZWRWYWx1ZTtcbiAgbGV0IGNvZXJjZWRUb0RhdGU7XG4gIHN3aXRjaCAocmVzdEtleSkge1xuICAgIGNhc2UgJ29iamVjdElkJzpcbiAgICAgIHJldHVybiB7IGtleTogJ19pZCcsIHZhbHVlOiByZXN0VmFsdWUgfTtcbiAgICBjYXNlICdleHBpcmVzQXQnOlxuICAgICAgdHJhbnNmb3JtZWRWYWx1ZSA9IHRyYW5zZm9ybVRvcExldmVsQXRvbShyZXN0VmFsdWUpO1xuICAgICAgY29lcmNlZFRvRGF0ZSA9XG4gICAgICAgIHR5cGVvZiB0cmFuc2Zvcm1lZFZhbHVlID09PSAnc3RyaW5nJyA/IG5ldyBEYXRlKHRyYW5zZm9ybWVkVmFsdWUpIDogdHJhbnNmb3JtZWRWYWx1ZTtcbiAgICAgIHJldHVybiB7IGtleTogJ2V4cGlyZXNBdCcsIHZhbHVlOiBjb2VyY2VkVG9EYXRlIH07XG4gICAgY2FzZSAnX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0JzpcbiAgICAgIHRyYW5zZm9ybWVkVmFsdWUgPSB0cmFuc2Zvcm1Ub3BMZXZlbEF0b20ocmVzdFZhbHVlKTtcbiAgICAgIGNvZXJjZWRUb0RhdGUgPVxuICAgICAgICB0eXBlb2YgdHJhbnNmb3JtZWRWYWx1ZSA9PT0gJ3N0cmluZycgPyBuZXcgRGF0ZSh0cmFuc2Zvcm1lZFZhbHVlKSA6IHRyYW5zZm9ybWVkVmFsdWU7XG4gICAgICByZXR1cm4geyBrZXk6ICdfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQnLCB2YWx1ZTogY29lcmNlZFRvRGF0ZSB9O1xuICAgIGNhc2UgJ19hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCc6XG4gICAgICB0cmFuc2Zvcm1lZFZhbHVlID0gdHJhbnNmb3JtVG9wTGV2ZWxBdG9tKHJlc3RWYWx1ZSk7XG4gICAgICBjb2VyY2VkVG9EYXRlID1cbiAgICAgICAgdHlwZW9mIHRyYW5zZm9ybWVkVmFsdWUgPT09ICdzdHJpbmcnID8gbmV3IERhdGUodHJhbnNmb3JtZWRWYWx1ZSkgOiB0cmFuc2Zvcm1lZFZhbHVlO1xuICAgICAgcmV0dXJuIHsga2V5OiAnX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0JywgdmFsdWU6IGNvZXJjZWRUb0RhdGUgfTtcbiAgICBjYXNlICdfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0JzpcbiAgICAgIHRyYW5zZm9ybWVkVmFsdWUgPSB0cmFuc2Zvcm1Ub3BMZXZlbEF0b20ocmVzdFZhbHVlKTtcbiAgICAgIGNvZXJjZWRUb0RhdGUgPVxuICAgICAgICB0eXBlb2YgdHJhbnNmb3JtZWRWYWx1ZSA9PT0gJ3N0cmluZycgPyBuZXcgRGF0ZSh0cmFuc2Zvcm1lZFZhbHVlKSA6IHRyYW5zZm9ybWVkVmFsdWU7XG4gICAgICByZXR1cm4geyBrZXk6ICdfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0JywgdmFsdWU6IGNvZXJjZWRUb0RhdGUgfTtcbiAgICBjYXNlICdfcGFzc3dvcmRfY2hhbmdlZF9hdCc6XG4gICAgICB0cmFuc2Zvcm1lZFZhbHVlID0gdHJhbnNmb3JtVG9wTGV2ZWxBdG9tKHJlc3RWYWx1ZSk7XG4gICAgICBjb2VyY2VkVG9EYXRlID1cbiAgICAgICAgdHlwZW9mIHRyYW5zZm9ybWVkVmFsdWUgPT09ICdzdHJpbmcnID8gbmV3IERhdGUodHJhbnNmb3JtZWRWYWx1ZSkgOiB0cmFuc2Zvcm1lZFZhbHVlO1xuICAgICAgcmV0dXJuIHsga2V5OiAnX3Bhc3N3b3JkX2NoYW5nZWRfYXQnLCB2YWx1ZTogY29lcmNlZFRvRGF0ZSB9O1xuICAgIGNhc2UgJ19mYWlsZWRfbG9naW5fY291bnQnOlxuICAgIGNhc2UgJ19ycGVybSc6XG4gICAgY2FzZSAnX3dwZXJtJzpcbiAgICBjYXNlICdfZW1haWxfdmVyaWZ5X3Rva2VuJzpcbiAgICBjYXNlICdfaGFzaGVkX3Bhc3N3b3JkJzpcbiAgICBjYXNlICdfcGVyaXNoYWJsZV90b2tlbic6XG4gICAgICByZXR1cm4geyBrZXk6IHJlc3RLZXksIHZhbHVlOiByZXN0VmFsdWUgfTtcbiAgICBjYXNlICdzZXNzaW9uVG9rZW4nOlxuICAgICAgcmV0dXJuIHsga2V5OiAnX3Nlc3Npb25fdG9rZW4nLCB2YWx1ZTogcmVzdFZhbHVlIH07XG4gICAgZGVmYXVsdDpcbiAgICAgIC8vIEF1dGggZGF0YSBzaG91bGQgaGF2ZSBiZWVuIHRyYW5zZm9ybWVkIGFscmVhZHlcbiAgICAgIGlmIChyZXN0S2V5Lm1hdGNoKC9eYXV0aERhdGFcXC4oW2EtekEtWjAtOV9dKylcXC5pZCQvKSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgJ2NhbiBvbmx5IHF1ZXJ5IG9uICcgKyByZXN0S2V5KTtcbiAgICAgIH1cbiAgICAgIC8vIFRydXN0IHRoYXQgdGhlIGF1dGggZGF0YSBoYXMgYmVlbiB0cmFuc2Zvcm1lZCBhbmQgc2F2ZSBpdCBkaXJlY3RseVxuICAgICAgaWYgKHJlc3RLZXkubWF0Y2goL15fYXV0aF9kYXRhX1thLXpBLVowLTlfXSskLykpIHtcbiAgICAgICAgcmV0dXJuIHsga2V5OiByZXN0S2V5LCB2YWx1ZTogcmVzdFZhbHVlIH07XG4gICAgICB9XG4gIH1cbiAgLy9za2lwIHN0cmFpZ2h0IHRvIHRyYW5zZm9ybVRvcExldmVsQXRvbSBmb3IgQnl0ZXMsIHRoZXkgZG9uJ3Qgc2hvdyB1cCBpbiB0aGUgc2NoZW1hIGZvciBzb21lIHJlYXNvblxuICBpZiAocmVzdFZhbHVlICYmIHJlc3RWYWx1ZS5fX3R5cGUgIT09ICdCeXRlcycpIHtcbiAgICAvL05vdGU6IFdlIG1heSBub3Qga25vdyB0aGUgdHlwZSBvZiBhIGZpZWxkIGhlcmUsIGFzIHRoZSB1c2VyIGNvdWxkIGJlIHNhdmluZyAobnVsbCkgdG8gYSBmaWVsZFxuICAgIC8vVGhhdCBuZXZlciBleGlzdGVkIGJlZm9yZSwgbWVhbmluZyB3ZSBjYW4ndCBpbmZlciB0aGUgdHlwZS5cbiAgICBpZiAoXG4gICAgICAoc2NoZW1hLmZpZWxkc1tyZXN0S2V5XSAmJiBzY2hlbWEuZmllbGRzW3Jlc3RLZXldLnR5cGUgPT0gJ1BvaW50ZXInKSB8fFxuICAgICAgcmVzdFZhbHVlLl9fdHlwZSA9PSAnUG9pbnRlcidcbiAgICApIHtcbiAgICAgIHJlc3RLZXkgPSAnX3BfJyArIHJlc3RLZXk7XG4gICAgfVxuICB9XG5cbiAgLy8gSGFuZGxlIGF0b21pYyB2YWx1ZXNcbiAgdmFyIHZhbHVlID0gdHJhbnNmb3JtVG9wTGV2ZWxBdG9tKHJlc3RWYWx1ZSk7XG4gIGlmICh2YWx1ZSAhPT0gQ2Fubm90VHJhbnNmb3JtKSB7XG4gICAgcmV0dXJuIHsga2V5OiByZXN0S2V5LCB2YWx1ZTogdmFsdWUgfTtcbiAgfVxuXG4gIC8vIEFDTHMgYXJlIGhhbmRsZWQgYmVmb3JlIHRoaXMgbWV0aG9kIGlzIGNhbGxlZFxuICAvLyBJZiBhbiBBQ0wga2V5IHN0aWxsIGV4aXN0cyBoZXJlLCBzb21ldGhpbmcgaXMgd3JvbmcuXG4gIGlmIChyZXN0S2V5ID09PSAnQUNMJykge1xuICAgIHRocm93ICdUaGVyZSB3YXMgYSBwcm9ibGVtIHRyYW5zZm9ybWluZyBhbiBBQ0wuJztcbiAgfVxuXG4gIC8vIEhhbmRsZSBhcnJheXNcbiAgaWYgKEFycmF5LmlzQXJyYXkocmVzdFZhbHVlKSkge1xuICAgIHZhbHVlID0gcmVzdFZhbHVlLm1hcCh0cmFuc2Zvcm1JbnRlcmlvclZhbHVlKTtcbiAgICByZXR1cm4geyBrZXk6IHJlc3RLZXksIHZhbHVlOiB2YWx1ZSB9O1xuICB9XG5cbiAgLy8gSGFuZGxlIG5vcm1hbCBvYmplY3RzIGJ5IHJlY3Vyc2luZ1xuICBpZiAoT2JqZWN0LmtleXMocmVzdFZhbHVlKS5zb21lKGtleSA9PiBrZXkuaW5jbHVkZXMoJyQnKSB8fCBrZXkuaW5jbHVkZXMoJy4nKSkpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX05FU1RFRF9LRVksXG4gICAgICBcIk5lc3RlZCBrZXlzIHNob3VsZCBub3QgY29udGFpbiB0aGUgJyQnIG9yICcuJyBjaGFyYWN0ZXJzXCJcbiAgICApO1xuICB9XG4gIHZhbHVlID0gbWFwVmFsdWVzKHJlc3RWYWx1ZSwgdHJhbnNmb3JtSW50ZXJpb3JWYWx1ZSk7XG5cbiAgcmV0dXJuIHsga2V5OiByZXN0S2V5LCB2YWx1ZSB9O1xufTtcblxuY29uc3QgcGFyc2VPYmplY3RUb01vbmdvT2JqZWN0Rm9yQ3JlYXRlID0gKGNsYXNzTmFtZSwgcmVzdENyZWF0ZSwgc2NoZW1hKSA9PiB7XG4gIHJlc3RDcmVhdGUgPSBhZGRMZWdhY3lBQ0wocmVzdENyZWF0ZSk7XG4gIGNvbnN0IG1vbmdvQ3JlYXRlID0ge307XG4gIGZvciAoY29uc3QgcmVzdEtleSBpbiByZXN0Q3JlYXRlKSB7XG4gICAgaWYgKHJlc3RDcmVhdGVbcmVzdEtleV0gJiYgcmVzdENyZWF0ZVtyZXN0S2V5XS5fX3R5cGUgPT09ICdSZWxhdGlvbicpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCB7IGtleSwgdmFsdWUgfSA9IHBhcnNlT2JqZWN0S2V5VmFsdWVUb01vbmdvT2JqZWN0S2V5VmFsdWUoXG4gICAgICByZXN0S2V5LFxuICAgICAgcmVzdENyZWF0ZVtyZXN0S2V5XSxcbiAgICAgIHNjaGVtYVxuICAgICk7XG4gICAgaWYgKHZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIG1vbmdvQ3JlYXRlW2tleV0gPSB2YWx1ZTtcbiAgICB9XG4gIH1cblxuICAvLyBVc2UgdGhlIGxlZ2FjeSBtb25nbyBmb3JtYXQgZm9yIGNyZWF0ZWRBdCBhbmQgdXBkYXRlZEF0XG4gIGlmIChtb25nb0NyZWF0ZS5jcmVhdGVkQXQpIHtcbiAgICBtb25nb0NyZWF0ZS5fY3JlYXRlZF9hdCA9IG5ldyBEYXRlKG1vbmdvQ3JlYXRlLmNyZWF0ZWRBdC5pc28gfHwgbW9uZ29DcmVhdGUuY3JlYXRlZEF0KTtcbiAgICBkZWxldGUgbW9uZ29DcmVhdGUuY3JlYXRlZEF0O1xuICB9XG4gIGlmIChtb25nb0NyZWF0ZS51cGRhdGVkQXQpIHtcbiAgICBtb25nb0NyZWF0ZS5fdXBkYXRlZF9hdCA9IG5ldyBEYXRlKG1vbmdvQ3JlYXRlLnVwZGF0ZWRBdC5pc28gfHwgbW9uZ29DcmVhdGUudXBkYXRlZEF0KTtcbiAgICBkZWxldGUgbW9uZ29DcmVhdGUudXBkYXRlZEF0O1xuICB9XG5cbiAgcmV0dXJuIG1vbmdvQ3JlYXRlO1xufTtcblxuLy8gTWFpbiBleHBvc2VkIG1ldGhvZCB0byBoZWxwIHVwZGF0ZSBvbGQgb2JqZWN0cy5cbmNvbnN0IHRyYW5zZm9ybVVwZGF0ZSA9IChjbGFzc05hbWUsIHJlc3RVcGRhdGUsIHBhcnNlRm9ybWF0U2NoZW1hKSA9PiB7XG4gIGNvbnN0IG1vbmdvVXBkYXRlID0ge307XG4gIGNvbnN0IGFjbCA9IGFkZExlZ2FjeUFDTChyZXN0VXBkYXRlKTtcbiAgaWYgKGFjbC5fcnBlcm0gfHwgYWNsLl93cGVybSB8fCBhY2wuX2FjbCkge1xuICAgIG1vbmdvVXBkYXRlLiRzZXQgPSB7fTtcbiAgICBpZiAoYWNsLl9ycGVybSkge1xuICAgICAgbW9uZ29VcGRhdGUuJHNldC5fcnBlcm0gPSBhY2wuX3JwZXJtO1xuICAgIH1cbiAgICBpZiAoYWNsLl93cGVybSkge1xuICAgICAgbW9uZ29VcGRhdGUuJHNldC5fd3Blcm0gPSBhY2wuX3dwZXJtO1xuICAgIH1cbiAgICBpZiAoYWNsLl9hY2wpIHtcbiAgICAgIG1vbmdvVXBkYXRlLiRzZXQuX2FjbCA9IGFjbC5fYWNsO1xuICAgIH1cbiAgfVxuICBmb3IgKHZhciByZXN0S2V5IGluIHJlc3RVcGRhdGUpIHtcbiAgICBpZiAocmVzdFVwZGF0ZVtyZXN0S2V5XSAmJiByZXN0VXBkYXRlW3Jlc3RLZXldLl9fdHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHZhciBvdXQgPSB0cmFuc2Zvcm1LZXlWYWx1ZUZvclVwZGF0ZShcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHJlc3RLZXksXG4gICAgICByZXN0VXBkYXRlW3Jlc3RLZXldLFxuICAgICAgcGFyc2VGb3JtYXRTY2hlbWFcbiAgICApO1xuXG4gICAgLy8gSWYgdGhlIG91dHB1dCB2YWx1ZSBpcyBhbiBvYmplY3Qgd2l0aCBhbnkgJCBrZXlzLCBpdCdzIGFuXG4gICAgLy8gb3BlcmF0b3IgdGhhdCBuZWVkcyB0byBiZSBsaWZ0ZWQgb250byB0aGUgdG9wIGxldmVsIHVwZGF0ZVxuICAgIC8vIG9iamVjdC5cbiAgICBpZiAodHlwZW9mIG91dC52YWx1ZSA9PT0gJ29iamVjdCcgJiYgb3V0LnZhbHVlICE9PSBudWxsICYmIG91dC52YWx1ZS5fX29wKSB7XG4gICAgICBtb25nb1VwZGF0ZVtvdXQudmFsdWUuX19vcF0gPSBtb25nb1VwZGF0ZVtvdXQudmFsdWUuX19vcF0gfHwge307XG4gICAgICBtb25nb1VwZGF0ZVtvdXQudmFsdWUuX19vcF1bb3V0LmtleV0gPSBvdXQudmFsdWUuYXJnO1xuICAgIH0gZWxzZSB7XG4gICAgICBtb25nb1VwZGF0ZVsnJHNldCddID0gbW9uZ29VcGRhdGVbJyRzZXQnXSB8fCB7fTtcbiAgICAgIG1vbmdvVXBkYXRlWyckc2V0J11bb3V0LmtleV0gPSBvdXQudmFsdWU7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG1vbmdvVXBkYXRlO1xufTtcblxuLy8gQWRkIHRoZSBsZWdhY3kgX2FjbCBmb3JtYXQuXG5jb25zdCBhZGRMZWdhY3lBQ0wgPSByZXN0T2JqZWN0ID0+IHtcbiAgY29uc3QgcmVzdE9iamVjdENvcHkgPSB7IC4uLnJlc3RPYmplY3QgfTtcbiAgY29uc3QgX2FjbCA9IHt9O1xuXG4gIGlmIChyZXN0T2JqZWN0Ll93cGVybSkge1xuICAgIHJlc3RPYmplY3QuX3dwZXJtLmZvckVhY2goZW50cnkgPT4ge1xuICAgICAgX2FjbFtlbnRyeV0gPSB7IHc6IHRydWUgfTtcbiAgICB9KTtcbiAgICByZXN0T2JqZWN0Q29weS5fYWNsID0gX2FjbDtcbiAgfVxuXG4gIGlmIChyZXN0T2JqZWN0Ll9ycGVybSkge1xuICAgIHJlc3RPYmplY3QuX3JwZXJtLmZvckVhY2goZW50cnkgPT4ge1xuICAgICAgLy8gT3duLXByb3BlcnR5IGNoZWNrIHNvIGFuIGluaGVyaXRlZCBtZW1iZXIgbmFtZSBpcyBuZXZlciByZWFkIGFzIHRoZSBjb250YWluZXJcbiAgICAgIGlmICghT2JqZWN0Lmhhc093bihfYWNsLCBlbnRyeSkpIHtcbiAgICAgICAgX2FjbFtlbnRyeV0gPSB7IHI6IHRydWUgfTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIF9hY2xbZW50cnldLnIgPSB0cnVlO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHJlc3RPYmplY3RDb3B5Ll9hY2wgPSBfYWNsO1xuICB9XG5cbiAgcmV0dXJuIHJlc3RPYmplY3RDb3B5O1xufTtcblxuLy8gQSBzZW50aW5lbCB2YWx1ZSB0aGF0IGhlbHBlciB0cmFuc2Zvcm1hdGlvbnMgcmV0dXJuIHdoZW4gdGhleVxuLy8gY2Fubm90IHBlcmZvcm0gYSB0cmFuc2Zvcm1hdGlvblxuZnVuY3Rpb24gQ2Fubm90VHJhbnNmb3JtKCkge31cblxuY29uc3QgdHJhbnNmb3JtSW50ZXJpb3JBdG9tID0gYXRvbSA9PiB7XG4gIC8vIFRPRE86IGNoZWNrIHZhbGlkaXR5IGhhcmRlciBmb3IgdGhlIF9fdHlwZS1kZWZpbmVkIHR5cGVzXG4gIGlmICh0eXBlb2YgYXRvbSA9PT0gJ29iamVjdCcgJiYgYXRvbSAmJiAhVXRpbHMuaXNEYXRlKGF0b20pICYmIGF0b20uX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICByZXR1cm4ge1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6IGF0b20uY2xhc3NOYW1lLFxuICAgICAgb2JqZWN0SWQ6IGF0b20ub2JqZWN0SWQsXG4gICAgfTtcbiAgfSBlbHNlIGlmICh0eXBlb2YgYXRvbSA9PT0gJ2Z1bmN0aW9uJyB8fCB0eXBlb2YgYXRvbSA9PT0gJ3N5bWJvbCcpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgY2Fubm90IHRyYW5zZm9ybSB2YWx1ZTogJHthdG9tfWApO1xuICB9IGVsc2UgaWYgKERhdGVDb2Rlci5pc1ZhbGlkSlNPTihhdG9tKSkge1xuICAgIHJldHVybiBEYXRlQ29kZXIuSlNPTlRvRGF0YWJhc2UoYXRvbSk7XG4gIH0gZWxzZSBpZiAoQnl0ZXNDb2Rlci5pc1ZhbGlkSlNPTihhdG9tKSkge1xuICAgIHJldHVybiBCeXRlc0NvZGVyLkpTT05Ub0RhdGFiYXNlKGF0b20pO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBhdG9tID09PSAnb2JqZWN0JyAmJiBhdG9tICYmIGF0b20uJHJlZ2V4ICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gbmV3IFJlZ0V4cChhdG9tLiRyZWdleCk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIGF0b207XG4gIH1cbn07XG5cbi8vIEhlbHBlciBmdW5jdGlvbiB0byB0cmFuc2Zvcm0gYW4gYXRvbSBmcm9tIFJFU1QgZm9ybWF0IHRvIE1vbmdvIGZvcm1hdC5cbi8vIEFuIGF0b20gaXMgYW55dGhpbmcgdGhhdCBjYW4ndCBjb250YWluIG90aGVyIGV4cHJlc3Npb25zLiBTbyBpdFxuLy8gaW5jbHVkZXMgdGhpbmdzIHdoZXJlIG9iamVjdHMgYXJlIHVzZWQgdG8gcmVwcmVzZW50IG90aGVyXG4vLyBkYXRhdHlwZXMsIGxpa2UgcG9pbnRlcnMgYW5kIGRhdGVzLCBidXQgaXQgZG9lcyBub3QgaW5jbHVkZSBvYmplY3RzXG4vLyBvciBhcnJheXMgd2l0aCBnZW5lcmljIHN0dWZmIGluc2lkZS5cbi8vIFJhaXNlcyBhbiBlcnJvciBpZiB0aGlzIGNhbm5vdCBwb3NzaWJseSBiZSB2YWxpZCBSRVNUIGZvcm1hdC5cbi8vIFJldHVybnMgQ2Fubm90VHJhbnNmb3JtIGlmIGl0J3MganVzdCBub3QgYW4gYXRvbVxuZnVuY3Rpb24gdHJhbnNmb3JtVG9wTGV2ZWxBdG9tKGF0b20sIGZpZWxkKSB7XG4gIHN3aXRjaCAodHlwZW9mIGF0b20pIHtcbiAgICBjYXNlICdudW1iZXInOlxuICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgIGNhc2UgJ3VuZGVmaW5lZCc6XG4gICAgICByZXR1cm4gYXRvbTtcbiAgICBjYXNlICdzdHJpbmcnOlxuICAgICAgaWYgKGZpZWxkICYmIGZpZWxkLnR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICByZXR1cm4gYCR7ZmllbGQudGFyZ2V0Q2xhc3N9JCR7YXRvbX1gO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGF0b207XG4gICAgY2FzZSAnc3ltYm9sJzpcbiAgICBjYXNlICdmdW5jdGlvbic6XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgY2Fubm90IHRyYW5zZm9ybSB2YWx1ZTogJHthdG9tfWApO1xuICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICBpZiAoVXRpbHMuaXNEYXRlKGF0b20pKSB7XG4gICAgICAgIC8vIFRlY2huaWNhbGx5IGRhdGVzIGFyZSBub3QgcmVzdCBmb3JtYXQsIGJ1dCwgaXQgc2VlbXMgcHJldHR5XG4gICAgICAgIC8vIGNsZWFyIHdoYXQgdGhleSBzaG91bGQgYmUgdHJhbnNmb3JtZWQgdG8sIHNvIGxldCdzIGp1c3QgZG8gaXQuXG4gICAgICAgIHJldHVybiBhdG9tO1xuICAgICAgfVxuXG4gICAgICBpZiAoYXRvbSA9PT0gbnVsbCkge1xuICAgICAgICByZXR1cm4gYXRvbTtcbiAgICAgIH1cblxuICAgICAgLy8gVE9ETzogY2hlY2sgdmFsaWRpdHkgaGFyZGVyIGZvciB0aGUgX190eXBlLWRlZmluZWQgdHlwZXNcbiAgICAgIGlmIChhdG9tLl9fdHlwZSA9PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuIGAke2F0b20uY2xhc3NOYW1lfSQke2F0b20ub2JqZWN0SWR9YDtcbiAgICAgIH1cbiAgICAgIGlmIChEYXRlQ29kZXIuaXNWYWxpZEpTT04oYXRvbSkpIHtcbiAgICAgICAgcmV0dXJuIERhdGVDb2Rlci5KU09OVG9EYXRhYmFzZShhdG9tKTtcbiAgICAgIH1cbiAgICAgIGlmIChCeXRlc0NvZGVyLmlzVmFsaWRKU09OKGF0b20pKSB7XG4gICAgICAgIHJldHVybiBCeXRlc0NvZGVyLkpTT05Ub0RhdGFiYXNlKGF0b20pO1xuICAgICAgfVxuICAgICAgaWYgKEdlb1BvaW50Q29kZXIuaXNWYWxpZEpTT04oYXRvbSkpIHtcbiAgICAgICAgcmV0dXJuIEdlb1BvaW50Q29kZXIuSlNPTlRvRGF0YWJhc2UoYXRvbSk7XG4gICAgICB9XG4gICAgICBpZiAoUG9seWdvbkNvZGVyLmlzVmFsaWRKU09OKGF0b20pKSB7XG4gICAgICAgIHJldHVybiBQb2x5Z29uQ29kZXIuSlNPTlRvRGF0YWJhc2UoYXRvbSk7XG4gICAgICB9XG4gICAgICBpZiAoRmlsZUNvZGVyLmlzVmFsaWRKU09OKGF0b20pKSB7XG4gICAgICAgIHJldHVybiBGaWxlQ29kZXIuSlNPTlRvRGF0YWJhc2UoYXRvbSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gQ2Fubm90VHJhbnNmb3JtO1xuXG4gICAgZGVmYXVsdDpcbiAgICAgIC8vIEkgZG9uJ3QgdGhpbmsgdHlwZW9mIGNhbiBldmVyIGxldCB1cyBnZXQgaGVyZVxuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsXG4gICAgICAgIGByZWFsbHkgZGlkIG5vdCBleHBlY3QgdmFsdWU6ICR7YXRvbX1gXG4gICAgICApO1xuICB9XG59XG5cbi8vIFRyYW5zZm9ybXMgYSBxdWVyeSBjb25zdHJhaW50IGZyb20gUkVTVCBBUEkgZm9ybWF0IHRvIE1vbmdvIGZvcm1hdC5cbi8vIEEgY29uc3RyYWludCBpcyBzb21ldGhpbmcgd2l0aCBmaWVsZHMgbGlrZSAkbHQuXG4vLyBJZiBpdCBpcyBub3QgYSB2YWxpZCBjb25zdHJhaW50IGJ1dCBpdCBjb3VsZCBiZSBhIHZhbGlkIHNvbWV0aGluZ1xuLy8gZWxzZSwgcmV0dXJuIENhbm5vdFRyYW5zZm9ybS5cbi8vIGluQXJyYXkgaXMgd2hldGhlciB0aGlzIGlzIGFuIGFycmF5IGZpZWxkLlxuZnVuY3Rpb24gdHJhbnNmb3JtQ29uc3RyYWludChjb25zdHJhaW50LCBmaWVsZCwgcXVlcnlLZXksIGNvdW50ID0gZmFsc2UpIHtcbiAgY29uc3QgaW5BcnJheSA9IGZpZWxkICYmIGZpZWxkLnR5cGUgJiYgZmllbGQudHlwZSA9PT0gJ0FycmF5JztcbiAgLy8gQ2hlY2sgd2V0aGVyIHRoZSBnaXZlbiBrZXkgaGFzIGAuYFxuICBjb25zdCBpc05lc3RlZEtleSA9IHF1ZXJ5S2V5LmluZGV4T2YoJy4nKSA+IC0xO1xuICBpZiAodHlwZW9mIGNvbnN0cmFpbnQgIT09ICdvYmplY3QnIHx8ICFjb25zdHJhaW50KSB7XG4gICAgcmV0dXJuIENhbm5vdFRyYW5zZm9ybTtcbiAgfVxuICAvLyBGb3IgaW5BcnJheSBvciBuZXN0ZWQga2V5LCB3ZSBuZWVkIHRvIHRyYW5zZm9ybSB0aGUgaW50ZXJpb3IgYXRvbVxuICBjb25zdCB0cmFuc2Zvcm1GdW5jdGlvbiA9IChpbkFycmF5IHx8IGlzTmVzdGVkS2V5KSA/IHRyYW5zZm9ybUludGVyaW9yQXRvbSA6IHRyYW5zZm9ybVRvcExldmVsQXRvbTtcbiAgY29uc3QgdHJhbnNmb3JtZXIgPSBhdG9tID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSB0cmFuc2Zvcm1GdW5jdGlvbihhdG9tLCBmaWVsZCk7XG4gICAgaWYgKHJlc3VsdCA9PT0gQ2Fubm90VHJhbnNmb3JtKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgYmFkIGF0b206ICR7SlNPTi5zdHJpbmdpZnkoYXRvbSl9YCk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG4gIC8vIGtleXMgaXMgdGhlIGNvbnN0cmFpbnRzIGluIHJldmVyc2UgYWxwaGFiZXRpY2FsIG9yZGVyLlxuICAvLyBUaGlzIGlzIGEgaGFjayBzbyB0aGF0OlxuICAvLyAgICRyZWdleCBpcyBoYW5kbGVkIGJlZm9yZSAkb3B0aW9uc1xuICAvLyAgICRuZWFyU3BoZXJlIGlzIGhhbmRsZWQgYmVmb3JlICRtYXhEaXN0YW5jZVxuICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKGNvbnN0cmFpbnQpLnNvcnQoKS5yZXZlcnNlKCk7XG4gIHZhciBhbnN3ZXIgPSB7fTtcbiAgZm9yICh2YXIga2V5IG9mIGtleXMpIHtcbiAgICBzd2l0Y2ggKGtleSkge1xuICAgICAgY2FzZSAnJGx0JzpcbiAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgY2FzZSAnJGd0JzpcbiAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgY2FzZSAnJGV4aXN0cyc6XG4gICAgICBjYXNlICckbmUnOlxuICAgICAgY2FzZSAnJGVxJzoge1xuICAgICAgICBjb25zdCB2YWwgPSBjb25zdHJhaW50W2tleV07XG4gICAgICAgIGlmICh2YWwgJiYgdHlwZW9mIHZhbCA9PT0gJ29iamVjdCcgJiYgdmFsLiRyZWxhdGl2ZVRpbWUpIHtcbiAgICAgICAgICBpZiAoZmllbGQgJiYgZmllbGQudHlwZSAhPT0gJ0RhdGUnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgJyRyZWxhdGl2ZVRpbWUgY2FuIG9ubHkgYmUgdXNlZCB3aXRoIERhdGUgZmllbGQnXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHN3aXRjaCAoa2V5KSB7XG4gICAgICAgICAgICBjYXNlICckZXhpc3RzJzpcbiAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICBjYXNlICckZXEnOlxuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgICAgICckcmVsYXRpdmVUaW1lIGNhbiBvbmx5IGJlIHVzZWQgd2l0aCB0aGUgJGx0LCAkbHRlLCAkZ3QsIGFuZCAkZ3RlIG9wZXJhdG9ycydcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBwYXJzZXJSZXN1bHQgPSBVdGlscy5yZWxhdGl2ZVRpbWVUb0RhdGUodmFsLiRyZWxhdGl2ZVRpbWUpO1xuICAgICAgICAgIGlmIChwYXJzZXJSZXN1bHQuc3RhdHVzID09PSAnc3VjY2VzcycpIHtcbiAgICAgICAgICAgIGFuc3dlcltrZXldID0gcGFyc2VyUmVzdWx0LnJlc3VsdDtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGxvZy5pbmZvKCdFcnJvciB3aGlsZSBwYXJzaW5nIHJlbGF0aXZlIGRhdGUnLCBwYXJzZXJSZXN1bHQpO1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgIGBiYWQgJHJlbGF0aXZlVGltZSAoJHtrZXl9KSB2YWx1ZS4gJHtwYXJzZXJSZXN1bHQuaW5mb31gXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGFuc3dlcltrZXldID0gdHJhbnNmb3JtZXIodmFsKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgJyRpbic6XG4gICAgICBjYXNlICckbmluJzoge1xuICAgICAgICBjb25zdCBhcnIgPSBjb25zdHJhaW50W2tleV07XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShhcnIpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ2JhZCAnICsga2V5ICsgJyB2YWx1ZScpO1xuICAgICAgICB9XG4gICAgICAgIGFuc3dlcltrZXldID0gXy5mbGF0TWFwKGFyciwgdmFsdWUgPT4ge1xuICAgICAgICAgIHJldHVybiAoYXRvbSA9PiB7XG4gICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShhdG9tKSkge1xuICAgICAgICAgICAgICByZXR1cm4gdmFsdWUubWFwKHRyYW5zZm9ybWVyKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHJldHVybiB0cmFuc2Zvcm1lcihhdG9tKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KSh2YWx1ZSk7XG4gICAgICAgIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJyRhbGwnOiB7XG4gICAgICAgIGNvbnN0IGFyciA9IGNvbnN0cmFpbnRba2V5XTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGFycikpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnYmFkICcgKyBrZXkgKyAnIHZhbHVlJyk7XG4gICAgICAgIH1cbiAgICAgICAgYW5zd2VyW2tleV0gPSBhcnIubWFwKHRyYW5zZm9ybUludGVyaW9yQXRvbSk7XG5cbiAgICAgICAgY29uc3QgdmFsdWVzID0gYW5zd2VyW2tleV07XG4gICAgICAgIGlmIChpc0FueVZhbHVlUmVnZXgodmFsdWVzKSAmJiAhaXNBbGxWYWx1ZXNSZWdleE9yTm9uZSh2YWx1ZXMpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgJ0FsbCAkYWxsIHZhbHVlcyBtdXN0IGJlIG9mIHJlZ2V4IHR5cGUgb3Igbm9uZTogJyArIHZhbHVlc1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJyRyZWdleCc6XG4gICAgICAgIHZhciBzID0gY29uc3RyYWludFtrZXldO1xuICAgICAgICBpZiAodHlwZW9mIHMgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ2JhZCByZWdleDogJyArIHMpO1xuICAgICAgICB9XG4gICAgICAgIGFuc3dlcltrZXldID0gcztcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgJyRjb250YWluZWRCeSc6IHtcbiAgICAgICAgY29uc3QgYXJyID0gY29uc3RyYWludFtrZXldO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoYXJyKSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sIGBiYWQgJGNvbnRhaW5lZEJ5OiBzaG91bGQgYmUgYW4gYXJyYXlgKTtcbiAgICAgICAgfVxuICAgICAgICBhbnN3ZXIuJGVsZW1NYXRjaCA9IHtcbiAgICAgICAgICAkbmluOiBhcnIubWFwKHRyYW5zZm9ybWVyKSxcbiAgICAgICAgfTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICckb3B0aW9ucyc6XG4gICAgICAgIGFuc3dlcltrZXldID0gY29uc3RyYWludFtrZXldO1xuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSAnJHRleHQnOiB7XG4gICAgICAgIGNvbnN0IHNlYXJjaCA9IGNvbnN0cmFpbnRba2V5XS4kc2VhcmNoO1xuICAgICAgICBpZiAodHlwZW9mIHNlYXJjaCAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgYmFkICR0ZXh0OiAkc2VhcmNoLCBzaG91bGQgYmUgb2JqZWN0YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFzZWFyY2guJHRlcm0gfHwgdHlwZW9mIHNlYXJjaC4kdGVybSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgYmFkICR0ZXh0OiAkdGVybSwgc2hvdWxkIGJlIHN0cmluZ2ApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGFuc3dlcltrZXldID0ge1xuICAgICAgICAgICAgJHNlYXJjaDogc2VhcmNoLiR0ZXJtLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNlYXJjaC4kbGFuZ3VhZ2UgJiYgdHlwZW9mIHNlYXJjaC4kbGFuZ3VhZ2UgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgYGJhZCAkdGV4dDogJGxhbmd1YWdlLCBzaG91bGQgYmUgc3RyaW5nYCk7XG4gICAgICAgIH0gZWxzZSBpZiAoc2VhcmNoLiRsYW5ndWFnZSkge1xuICAgICAgICAgIGFuc3dlcltrZXldLiRsYW5ndWFnZSA9IHNlYXJjaC4kbGFuZ3VhZ2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNlYXJjaC4kY2FzZVNlbnNpdGl2ZSAmJiB0eXBlb2Ygc2VhcmNoLiRjYXNlU2Vuc2l0aXZlICE9PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICBgYmFkICR0ZXh0OiAkY2FzZVNlbnNpdGl2ZSwgc2hvdWxkIGJlIGJvb2xlYW5gXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIGlmIChzZWFyY2guJGNhc2VTZW5zaXRpdmUpIHtcbiAgICAgICAgICBhbnN3ZXJba2V5XS4kY2FzZVNlbnNpdGl2ZSA9IHNlYXJjaC4kY2FzZVNlbnNpdGl2ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2VhcmNoLiRkaWFjcml0aWNTZW5zaXRpdmUgJiYgdHlwZW9mIHNlYXJjaC4kZGlhY3JpdGljU2Vuc2l0aXZlICE9PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICBgYmFkICR0ZXh0OiAkZGlhY3JpdGljU2Vuc2l0aXZlLCBzaG91bGQgYmUgYm9vbGVhbmBcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2UgaWYgKHNlYXJjaC4kZGlhY3JpdGljU2Vuc2l0aXZlKSB7XG4gICAgICAgICAgYW5zd2VyW2tleV0uJGRpYWNyaXRpY1NlbnNpdGl2ZSA9IHNlYXJjaC4kZGlhY3JpdGljU2Vuc2l0aXZlO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSAnJG5lYXJTcGhlcmUnOiB7XG4gICAgICAgIGNvbnN0IHBvaW50ID0gY29uc3RyYWludFtrZXldO1xuICAgICAgICBpZiAoY291bnQpIHtcbiAgICAgICAgICBhbnN3ZXIuJGdlb1dpdGhpbiA9IHtcbiAgICAgICAgICAgICRjZW50ZXJTcGhlcmU6IFtbcG9pbnQubG9uZ2l0dWRlLCBwb2ludC5sYXRpdHVkZV0sIGNvbnN0cmFpbnQuJG1heERpc3RhbmNlXSxcbiAgICAgICAgICB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGFuc3dlcltrZXldID0gW3BvaW50LmxvbmdpdHVkZSwgcG9pbnQubGF0aXR1ZGVdO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSAnJG1heERpc3RhbmNlJzoge1xuICAgICAgICBpZiAoY291bnQpIHtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICBhbnN3ZXJba2V5XSA9IGNvbnN0cmFpbnRba2V5XTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICAvLyBUaGUgU0RLcyBkb24ndCBzZWVtIHRvIHVzZSB0aGVzZSBidXQgdGhleSBhcmUgZG9jdW1lbnRlZCBpbiB0aGVcbiAgICAgIC8vIFJFU1QgQVBJIGRvY3MuXG4gICAgICBjYXNlICckbWF4RGlzdGFuY2VJblJhZGlhbnMnOlxuICAgICAgICBhbnN3ZXJbJyRtYXhEaXN0YW5jZSddID0gY29uc3RyYWludFtrZXldO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJyRtYXhEaXN0YW5jZUluTWlsZXMnOlxuICAgICAgICBhbnN3ZXJbJyRtYXhEaXN0YW5jZSddID0gY29uc3RyYWludFtrZXldIC8gMzk1OTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICckbWF4RGlzdGFuY2VJbktpbG9tZXRlcnMnOlxuICAgICAgICBhbnN3ZXJbJyRtYXhEaXN0YW5jZSddID0gY29uc3RyYWludFtrZXldIC8gNjM3MTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgJyRzZWxlY3QnOlxuICAgICAgY2FzZSAnJGRvbnRTZWxlY3QnOlxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuQ09NTUFORF9VTkFWQUlMQUJMRSxcbiAgICAgICAgICAndGhlICcgKyBrZXkgKyAnIGNvbnN0cmFpbnQgaXMgbm90IHN1cHBvcnRlZCB5ZXQnXG4gICAgICAgICk7XG5cbiAgICAgIGNhc2UgJyR3aXRoaW4nOlxuICAgICAgICB2YXIgYm94ID0gY29uc3RyYWludFtrZXldWyckYm94J107XG4gICAgICAgIGlmICghYm94IHx8IGJveC5sZW5ndGggIT0gMikge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdtYWxmb3JtYXR0ZWQgJHdpdGhpbiBhcmcnKTtcbiAgICAgICAgfVxuICAgICAgICBhbnN3ZXJba2V5XSA9IHtcbiAgICAgICAgICAkYm94OiBbXG4gICAgICAgICAgICBbYm94WzBdLmxvbmdpdHVkZSwgYm94WzBdLmxhdGl0dWRlXSxcbiAgICAgICAgICAgIFtib3hbMV0ubG9uZ2l0dWRlLCBib3hbMV0ubGF0aXR1ZGVdLFxuICAgICAgICAgIF0sXG4gICAgICAgIH07XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlICckZ2VvV2l0aGluJzoge1xuICAgICAgICBjb25zdCBwb2x5Z29uID0gY29uc3RyYWludFtrZXldWyckcG9seWdvbiddO1xuICAgICAgICBjb25zdCBjZW50ZXJTcGhlcmUgPSBjb25zdHJhaW50W2tleV1bJyRjZW50ZXJTcGhlcmUnXTtcbiAgICAgICAgaWYgKHBvbHlnb24gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGxldCBwb2ludHM7XG4gICAgICAgICAgaWYgKHR5cGVvZiBwb2x5Z29uID09PSAnb2JqZWN0JyAmJiBwb2x5Z29uLl9fdHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgICAgICBpZiAoIXBvbHlnb24uY29vcmRpbmF0ZXMgfHwgcG9seWdvbi5jb29yZGluYXRlcy5sZW5ndGggPCAzKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICAgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlOyBQb2x5Z29uLmNvb3JkaW5hdGVzIHNob3VsZCBjb250YWluIGF0IGxlYXN0IDMgbG9uL2xhdCBwYWlycydcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHBvaW50cyA9IHBvbHlnb24uY29vcmRpbmF0ZXM7XG4gICAgICAgICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHBvbHlnb24pKSB7XG4gICAgICAgICAgICBpZiAocG9seWdvbi5sZW5ndGggPCAzKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICAgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlOyAkcG9seWdvbiBzaG91bGQgY29udGFpbiBhdCBsZWFzdCAzIEdlb1BvaW50cydcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHBvaW50cyA9IHBvbHlnb247XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgICBcImJhZCAkZ2VvV2l0aGluIHZhbHVlOyAkcG9seWdvbiBzaG91bGQgYmUgUG9seWdvbiBvYmplY3Qgb3IgQXJyYXkgb2YgUGFyc2UuR2VvUG9pbnQnc1wiXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBwb2ludHMgPSBwb2ludHMubWFwKHBvaW50ID0+IHtcbiAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHBvaW50KSAmJiBwb2ludC5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50WzFdLCBwb2ludFswXSk7XG4gICAgICAgICAgICAgIHJldHVybiBwb2ludDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghR2VvUG9pbnRDb2Rlci5pc1ZhbGlkSlNPTihwb2ludCkpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlJyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBQYXJzZS5HZW9Qb2ludC5fdmFsaWRhdGUocG9pbnQubGF0aXR1ZGUsIHBvaW50LmxvbmdpdHVkZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gW3BvaW50LmxvbmdpdHVkZSwgcG9pbnQubGF0aXR1ZGVdO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIGFuc3dlcltrZXldID0ge1xuICAgICAgICAgICAgJHBvbHlnb246IHBvaW50cyxcbiAgICAgICAgICB9O1xuICAgICAgICB9IGVsc2UgaWYgKGNlbnRlclNwaGVyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGNlbnRlclNwaGVyZSkgfHwgY2VudGVyU3BoZXJlLmxlbmd0aCA8IDIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgICAnYmFkICRnZW9XaXRoaW4gdmFsdWU7ICRjZW50ZXJTcGhlcmUgc2hvdWxkIGJlIGFuIGFycmF5IG9mIFBhcnNlLkdlb1BvaW50IGFuZCBkaXN0YW5jZSdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEdldCBwb2ludCwgY29udmVydCB0byBnZW8gcG9pbnQgaWYgbmVjZXNzYXJ5IGFuZCB2YWxpZGF0ZVxuICAgICAgICAgIGxldCBwb2ludCA9IGNlbnRlclNwaGVyZVswXTtcbiAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShwb2ludCkgJiYgcG9pbnQubGVuZ3RoID09PSAyKSB7XG4gICAgICAgICAgICBwb2ludCA9IG5ldyBQYXJzZS5HZW9Qb2ludChwb2ludFsxXSwgcG9pbnRbMF0pO1xuICAgICAgICAgIH0gZWxzZSBpZiAoIUdlb1BvaW50Q29kZXIuaXNWYWxpZEpTT04ocG9pbnQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlOyAkY2VudGVyU3BoZXJlIGdlbyBwb2ludCBpbnZhbGlkJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50LmxhdGl0dWRlLCBwb2ludC5sb25naXR1ZGUpO1xuICAgICAgICAgIC8vIEdldCBkaXN0YW5jZSBhbmQgdmFsaWRhdGVcbiAgICAgICAgICBjb25zdCBkaXN0YW5jZSA9IGNlbnRlclNwaGVyZVsxXTtcbiAgICAgICAgICBpZiAoaXNOYU4oZGlzdGFuY2UpIHx8IGRpc3RhbmNlIDwgMCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICdiYWQgJGdlb1dpdGhpbiB2YWx1ZTsgJGNlbnRlclNwaGVyZSBkaXN0YW5jZSBpbnZhbGlkJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgYW5zd2VyW2tleV0gPSB7XG4gICAgICAgICAgICAkY2VudGVyU3BoZXJlOiBbW3BvaW50LmxvbmdpdHVkZSwgcG9pbnQubGF0aXR1ZGVdLCBkaXN0YW5jZV0sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJyRnZW9JbnRlcnNlY3RzJzoge1xuICAgICAgICBjb25zdCBwb2ludCA9IGNvbnN0cmFpbnRba2V5XVsnJHBvaW50J107XG4gICAgICAgIGlmICghR2VvUG9pbnRDb2Rlci5pc1ZhbGlkSlNPTihwb2ludCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAnYmFkICRnZW9JbnRlcnNlY3QgdmFsdWU7ICRwb2ludCBzaG91bGQgYmUgR2VvUG9pbnQnXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBQYXJzZS5HZW9Qb2ludC5fdmFsaWRhdGUocG9pbnQubGF0aXR1ZGUsIHBvaW50LmxvbmdpdHVkZSk7XG4gICAgICAgIH1cbiAgICAgICAgYW5zd2VyW2tleV0gPSB7XG4gICAgICAgICAgJGdlb21ldHJ5OiB7XG4gICAgICAgICAgICB0eXBlOiAnUG9pbnQnLFxuICAgICAgICAgICAgY29vcmRpbmF0ZXM6IFtwb2ludC5sb25naXR1ZGUsIHBvaW50LmxhdGl0dWRlXSxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGlmIChrZXkubWF0Y2goL15cXCQrLykpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnYmFkIGNvbnN0cmFpbnQ6ICcgKyBrZXkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBDYW5ub3RUcmFuc2Zvcm07XG4gICAgfVxuICB9XG4gIHJldHVybiBhbnN3ZXI7XG59XG5cbi8vIFRyYW5zZm9ybXMgYW4gdXBkYXRlIG9wZXJhdG9yIGZyb20gUkVTVCBmb3JtYXQgdG8gbW9uZ28gZm9ybWF0LlxuLy8gVG8gYmUgdHJhbnNmb3JtZWQsIHRoZSBpbnB1dCBzaG91bGQgaGF2ZSBhbiBfX29wIGZpZWxkLlxuLy8gSWYgZmxhdHRlbiBpcyB0cnVlLCB0aGlzIHdpbGwgZmxhdHRlbiBvcGVyYXRvcnMgdG8gdGhlaXIgc3RhdGljXG4vLyBkYXRhIGZvcm1hdC4gRm9yIGV4YW1wbGUsIGFuIGluY3JlbWVudCBvZiAyIHdvdWxkIHNpbXBseSBiZWNvbWUgYVxuLy8gMi5cbi8vIFRoZSBvdXRwdXQgZm9yIGEgbm9uLWZsYXR0ZW5lZCBvcGVyYXRvciBpcyBhIGhhc2ggd2l0aCBfX29wIGJlaW5nXG4vLyB0aGUgbW9uZ28gb3AsIGFuZCBhcmcgYmVpbmcgdGhlIGFyZ3VtZW50LlxuLy8gVGhlIG91dHB1dCBmb3IgYSBmbGF0dGVuZWQgb3BlcmF0b3IgaXMganVzdCBhIHZhbHVlLlxuLy8gUmV0dXJucyB1bmRlZmluZWQgaWYgdGhpcyBzaG91bGQgYmUgYSBuby1vcC5cblxuZnVuY3Rpb24gdHJhbnNmb3JtVXBkYXRlT3BlcmF0b3IoeyBfX29wLCBhbW91bnQsIG9iamVjdHMgfSwgZmxhdHRlbikge1xuICBzd2l0Y2ggKF9fb3ApIHtcbiAgICBjYXNlICdEZWxldGUnOlxuICAgICAgaWYgKGZsYXR0ZW4pIHtcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiB7IF9fb3A6ICckdW5zZXQnLCBhcmc6ICcnIH07XG4gICAgICB9XG5cbiAgICBjYXNlICdJbmNyZW1lbnQnOlxuICAgICAgaWYgKHR5cGVvZiBhbW91bnQgIT09ICdudW1iZXInKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdpbmNyZW1lbnRpbmcgbXVzdCBwcm92aWRlIGEgbnVtYmVyJyk7XG4gICAgICB9XG4gICAgICBpZiAoZmxhdHRlbikge1xuICAgICAgICByZXR1cm4gYW1vdW50O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIHsgX19vcDogJyRpbmMnLCBhcmc6IGFtb3VudCB9O1xuICAgICAgfVxuXG4gICAgY2FzZSAnU2V0T25JbnNlcnQnOlxuICAgICAgaWYgKGZsYXR0ZW4pIHtcbiAgICAgICAgcmV0dXJuIGFtb3VudDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiB7IF9fb3A6ICckc2V0T25JbnNlcnQnLCBhcmc6IGFtb3VudCB9O1xuICAgICAgfVxuXG4gICAgY2FzZSAnQWRkJzpcbiAgICBjYXNlICdBZGRVbmlxdWUnOlxuICAgICAgaWYgKCFBcnJheS5pc0FycmF5KG9iamVjdHMpKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdvYmplY3RzIHRvIGFkZCBtdXN0IGJlIGFuIGFycmF5Jyk7XG4gICAgICB9XG4gICAgICB2YXIgdG9BZGQgPSBvYmplY3RzLm1hcCh0cmFuc2Zvcm1JbnRlcmlvckF0b20pO1xuICAgICAgaWYgKGZsYXR0ZW4pIHtcbiAgICAgICAgcmV0dXJuIHRvQWRkO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIG1vbmdvT3AgPSB7XG4gICAgICAgICAgQWRkOiAnJHB1c2gnLFxuICAgICAgICAgIEFkZFVuaXF1ZTogJyRhZGRUb1NldCcsXG4gICAgICAgIH1bX19vcF07XG4gICAgICAgIHJldHVybiB7IF9fb3A6IG1vbmdvT3AsIGFyZzogeyAkZWFjaDogdG9BZGQgfSB9O1xuICAgICAgfVxuXG4gICAgY2FzZSAnUmVtb3ZlJzpcbiAgICAgIGlmICghQXJyYXkuaXNBcnJheShvYmplY3RzKSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnb2JqZWN0cyB0byByZW1vdmUgbXVzdCBiZSBhbiBhcnJheScpO1xuICAgICAgfVxuICAgICAgdmFyIHRvUmVtb3ZlID0gb2JqZWN0cy5tYXAodHJhbnNmb3JtSW50ZXJpb3JBdG9tKTtcbiAgICAgIGlmIChmbGF0dGVuKSB7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiB7IF9fb3A6ICckcHVsbEFsbCcsIGFyZzogdG9SZW1vdmUgfTtcbiAgICAgIH1cblxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLkNPTU1BTkRfVU5BVkFJTEFCTEUsXG4gICAgICAgIGBUaGUgJHtfX29wfSBvcGVyYXRvciBpcyBub3Qgc3VwcG9ydGVkIHlldC5gXG4gICAgICApO1xuICB9XG59XG5mdW5jdGlvbiBtYXBWYWx1ZXMob2JqZWN0LCBpdGVyYXRvcikge1xuICBjb25zdCByZXN1bHQgPSB7fTtcbiAgT2JqZWN0LmtleXMob2JqZWN0KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgcmVzdWx0W2tleV0gPSBpdGVyYXRvcihvYmplY3Rba2V5XSk7XG4gIH0pO1xuICByZXR1cm4gcmVzdWx0O1xufVxuXG5jb25zdCBuZXN0ZWRNb25nb09iamVjdFRvTmVzdGVkUGFyc2VPYmplY3QgPSBtb25nb09iamVjdCA9PiB7XG4gIHN3aXRjaCAodHlwZW9mIG1vbmdvT2JqZWN0KSB7XG4gICAgY2FzZSAnc3RyaW5nJzpcbiAgICBjYXNlICdudW1iZXInOlxuICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgIGNhc2UgJ3VuZGVmaW5lZCc6XG4gICAgICByZXR1cm4gbW9uZ29PYmplY3Q7XG4gICAgY2FzZSAnc3ltYm9sJzpcbiAgICBjYXNlICdmdW5jdGlvbic6XG4gICAgICB0aHJvdyAnYmFkIHZhbHVlIGluIG5lc3RlZE1vbmdvT2JqZWN0VG9OZXN0ZWRQYXJzZU9iamVjdCc7XG4gICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgIGlmIChtb25nb09iamVjdCA9PT0gbnVsbCkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmIChBcnJheS5pc0FycmF5KG1vbmdvT2JqZWN0KSkge1xuICAgICAgICByZXR1cm4gbW9uZ29PYmplY3QubWFwKG5lc3RlZE1vbmdvT2JqZWN0VG9OZXN0ZWRQYXJzZU9iamVjdCk7XG4gICAgICB9XG5cbiAgICAgIGlmIChVdGlscy5pc0RhdGUobW9uZ29PYmplY3QpKSB7XG4gICAgICAgIHJldHVybiBQYXJzZS5fZW5jb2RlKG1vbmdvT2JqZWN0KTtcbiAgICAgIH1cblxuICAgICAgaWYgKG1vbmdvT2JqZWN0IGluc3RhbmNlb2YgbW9uZ29kYi5Mb25nKSB7XG4gICAgICAgIHJldHVybiBtb25nb09iamVjdC50b051bWJlcigpO1xuICAgICAgfVxuXG4gICAgICBpZiAobW9uZ29PYmplY3QgaW5zdGFuY2VvZiBtb25nb2RiLkRvdWJsZSkge1xuICAgICAgICByZXR1cm4gbW9uZ29PYmplY3QudmFsdWU7XG4gICAgICB9XG5cbiAgICAgIGlmIChCeXRlc0NvZGVyLmlzVmFsaWREYXRhYmFzZU9iamVjdChtb25nb09iamVjdCkpIHtcbiAgICAgICAgcmV0dXJuIEJ5dGVzQ29kZXIuZGF0YWJhc2VUb0pTT04obW9uZ29PYmplY3QpO1xuICAgICAgfVxuXG4gICAgICBpZiAoXG4gICAgICAgIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChtb25nb09iamVjdCwgJ19fdHlwZScpICYmXG4gICAgICAgIG1vbmdvT2JqZWN0Ll9fdHlwZSA9PSAnRGF0ZScgJiZcbiAgICAgICAgVXRpbHMuaXNEYXRlKG1vbmdvT2JqZWN0LmlzbylcbiAgICAgICkge1xuICAgICAgICBtb25nb09iamVjdC5pc28gPSBtb25nb09iamVjdC5pc28udG9KU09OKCk7XG4gICAgICAgIHJldHVybiBtb25nb09iamVjdDtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIG1hcFZhbHVlcyhtb25nb09iamVjdCwgbmVzdGVkTW9uZ29PYmplY3RUb05lc3RlZFBhcnNlT2JqZWN0KTtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgJ3Vua25vd24ganMgdHlwZSc7XG4gIH1cbn07XG5cbmNvbnN0IHRyYW5zZm9ybVBvaW50ZXJTdHJpbmcgPSAoc2NoZW1hLCBmaWVsZCwgcG9pbnRlclN0cmluZykgPT4ge1xuICBjb25zdCBvYmpEYXRhID0gcG9pbnRlclN0cmluZy5zcGxpdCgnJCcpO1xuICBpZiAob2JqRGF0YVswXSAhPT0gc2NoZW1hLmZpZWxkc1tmaWVsZF0udGFyZ2V0Q2xhc3MpIHtcbiAgICB0aHJvdyAncG9pbnRlciB0byBpbmNvcnJlY3QgY2xhc3NOYW1lJztcbiAgfVxuICByZXR1cm4ge1xuICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgIGNsYXNzTmFtZTogb2JqRGF0YVswXSxcbiAgICBvYmplY3RJZDogb2JqRGF0YVsxXSxcbiAgfTtcbn07XG5cbi8vIENvbnZlcnRzIGZyb20gYSBtb25nby1mb3JtYXQgb2JqZWN0IHRvIGEgUkVTVC1mb3JtYXQgb2JqZWN0LlxuLy8gRG9lcyBub3Qgc3RyaXAgb3V0IGFueXRoaW5nIGJhc2VkIG9uIGEgbGFjayBvZiBhdXRoZW50aWNhdGlvbi5cbmNvbnN0IG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdCA9IChjbGFzc05hbWUsIG1vbmdvT2JqZWN0LCBzY2hlbWEpID0+IHtcbiAgc3dpdGNoICh0eXBlb2YgbW9uZ29PYmplY3QpIHtcbiAgICBjYXNlICdzdHJpbmcnOlxuICAgIGNhc2UgJ251bWJlcic6XG4gICAgY2FzZSAnYm9vbGVhbic6XG4gICAgY2FzZSAndW5kZWZpbmVkJzpcbiAgICAgIHJldHVybiBtb25nb09iamVjdDtcbiAgICBjYXNlICdzeW1ib2wnOlxuICAgIGNhc2UgJ2Z1bmN0aW9uJzpcbiAgICAgIHRocm93ICdiYWQgdmFsdWUgaW4gbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0JztcbiAgICBjYXNlICdvYmplY3QnOiB7XG4gICAgICBpZiAobW9uZ29PYmplY3QgPT09IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShtb25nb09iamVjdCkpIHtcbiAgICAgICAgcmV0dXJuIG1vbmdvT2JqZWN0Lm1hcChuZXN0ZWRNb25nb09iamVjdFRvTmVzdGVkUGFyc2VPYmplY3QpO1xuICAgICAgfVxuXG4gICAgICBpZiAoVXRpbHMuaXNEYXRlKG1vbmdvT2JqZWN0KSkge1xuICAgICAgICByZXR1cm4gUGFyc2UuX2VuY29kZShtb25nb09iamVjdCk7XG4gICAgICB9XG5cbiAgICAgIGlmIChtb25nb09iamVjdCBpbnN0YW5jZW9mIG1vbmdvZGIuTG9uZykge1xuICAgICAgICByZXR1cm4gbW9uZ29PYmplY3QudG9OdW1iZXIoKTtcbiAgICAgIH1cblxuICAgICAgaWYgKG1vbmdvT2JqZWN0IGluc3RhbmNlb2YgbW9uZ29kYi5Eb3VibGUpIHtcbiAgICAgICAgcmV0dXJuIG1vbmdvT2JqZWN0LnZhbHVlO1xuICAgICAgfVxuXG4gICAgICBpZiAoQnl0ZXNDb2Rlci5pc1ZhbGlkRGF0YWJhc2VPYmplY3QobW9uZ29PYmplY3QpKSB7XG4gICAgICAgIHJldHVybiBCeXRlc0NvZGVyLmRhdGFiYXNlVG9KU09OKG1vbmdvT2JqZWN0KTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdE9iamVjdCA9IHt9O1xuICAgICAgaWYgKG1vbmdvT2JqZWN0Ll9ycGVybSB8fCBtb25nb09iamVjdC5fd3Blcm0pIHtcbiAgICAgICAgcmVzdE9iamVjdC5fcnBlcm0gPSBtb25nb09iamVjdC5fcnBlcm0gfHwgW107XG4gICAgICAgIHJlc3RPYmplY3QuX3dwZXJtID0gbW9uZ29PYmplY3QuX3dwZXJtIHx8IFtdO1xuICAgICAgICBkZWxldGUgbW9uZ29PYmplY3QuX3JwZXJtO1xuICAgICAgICBkZWxldGUgbW9uZ29PYmplY3QuX3dwZXJtO1xuICAgICAgfVxuXG4gICAgICBmb3IgKHZhciBrZXkgaW4gbW9uZ29PYmplY3QpIHtcbiAgICAgICAgc3dpdGNoIChrZXkpIHtcbiAgICAgICAgICBjYXNlICdfaWQnOlxuICAgICAgICAgICAgcmVzdE9iamVjdFsnb2JqZWN0SWQnXSA9ICcnICsgbW9uZ29PYmplY3Rba2V5XTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ19oYXNoZWRfcGFzc3dvcmQnOlxuICAgICAgICAgICAgcmVzdE9iamVjdC5faGFzaGVkX3Bhc3N3b3JkID0gbW9uZ29PYmplY3Rba2V5XTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ19hY2wnOlxuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnX2VtYWlsX3ZlcmlmeV90b2tlbic6XG4gICAgICAgICAgY2FzZSAnX3BlcmlzaGFibGVfdG9rZW4nOlxuICAgICAgICAgIGNhc2UgJ19wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQnOlxuICAgICAgICAgIGNhc2UgJ19wYXNzd29yZF9jaGFuZ2VkX2F0JzpcbiAgICAgICAgICBjYXNlICdfdG9tYnN0b25lJzpcbiAgICAgICAgICBjYXNlICdfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQnOlxuICAgICAgICAgIGNhc2UgJ19hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCc6XG4gICAgICAgICAgY2FzZSAnX2ZhaWxlZF9sb2dpbl9jb3VudCc6XG4gICAgICAgICAgY2FzZSAnX3Bhc3N3b3JkX2hpc3RvcnknOlxuICAgICAgICAgICAgLy8gVGhvc2Uga2V5cyB3aWxsIGJlIGRlbGV0ZWQgaWYgbmVlZGVkIGluIHRoZSBEQiBDb250cm9sbGVyXG4gICAgICAgICAgICByZXN0T2JqZWN0W2tleV0gPSBtb25nb09iamVjdFtrZXldO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnX3Nlc3Npb25fdG9rZW4nOlxuICAgICAgICAgICAgcmVzdE9iamVjdFsnc2Vzc2lvblRva2VuJ10gPSBtb25nb09iamVjdFtrZXldO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAndXBkYXRlZEF0JzpcbiAgICAgICAgICBjYXNlICdfdXBkYXRlZF9hdCc6XG4gICAgICAgICAgICByZXN0T2JqZWN0Wyd1cGRhdGVkQXQnXSA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUobW9uZ29PYmplY3Rba2V5XSkpLmlzbztcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ2NyZWF0ZWRBdCc6XG4gICAgICAgICAgY2FzZSAnX2NyZWF0ZWRfYXQnOlxuICAgICAgICAgICAgcmVzdE9iamVjdFsnY3JlYXRlZEF0J10gPSBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKG1vbmdvT2JqZWN0W2tleV0pKS5pc287XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICdleHBpcmVzQXQnOlxuICAgICAgICAgIGNhc2UgJ19leHBpcmVzQXQnOlxuICAgICAgICAgICAgcmVzdE9iamVjdFsnZXhwaXJlc0F0J10gPSBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKG1vbmdvT2JqZWN0W2tleV0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ2xhc3RVc2VkJzpcbiAgICAgICAgICBjYXNlICdfbGFzdF91c2VkJzpcbiAgICAgICAgICAgIHJlc3RPYmplY3RbJ2xhc3RVc2VkJ10gPSBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKG1vbmdvT2JqZWN0W2tleV0pKS5pc287XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICd0aW1lc1VzZWQnOlxuICAgICAgICAgIGNhc2UgJ3RpbWVzX3VzZWQnOlxuICAgICAgICAgICAgcmVzdE9iamVjdFsndGltZXNVc2VkJ10gPSBtb25nb09iamVjdFtrZXldO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnYXV0aERhdGEnOlxuICAgICAgICAgICAgaWYgKGNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgICAgICAgICAgICBsb2cud2FybihcbiAgICAgICAgICAgICAgICAnaWdub3JpbmcgYXV0aERhdGEgaW4gX1VzZXIgYXMgdGhpcyBrZXkgaXMgcmVzZXJ2ZWQgdG8gYmUgc3ludGhlc2l6ZWQgb2YgYF9hdXRoX2RhdGFfKmAga2V5cydcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHJlc3RPYmplY3RbJ2F1dGhEYXRhJ10gPSBtb25nb09iamVjdFtrZXldO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIC8vIENoZWNrIG90aGVyIGF1dGggZGF0YSBrZXlzXG4gICAgICAgICAgICB2YXIgYXV0aERhdGFNYXRjaCA9IGtleS5tYXRjaCgvXl9hdXRoX2RhdGFfKFthLXpBLVowLTlfXSspJC8pO1xuICAgICAgICAgICAgaWYgKGF1dGhEYXRhTWF0Y2ggJiYgY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICAgICAgICAgIHZhciBwcm92aWRlciA9IGF1dGhEYXRhTWF0Y2hbMV07XG4gICAgICAgICAgICAgIHJlc3RPYmplY3RbJ2F1dGhEYXRhJ10gPSByZXN0T2JqZWN0WydhdXRoRGF0YSddIHx8IHt9O1xuICAgICAgICAgICAgICByZXN0T2JqZWN0WydhdXRoRGF0YSddW3Byb3ZpZGVyXSA9IG1vbmdvT2JqZWN0W2tleV07XG4gICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoa2V5LmluZGV4T2YoJ19wXycpID09IDApIHtcbiAgICAgICAgICAgICAgdmFyIG5ld0tleSA9IGtleS5zdWJzdHJpbmcoMyk7XG4gICAgICAgICAgICAgIGlmICghc2NoZW1hLmZpZWxkc1tuZXdLZXldKSB7XG4gICAgICAgICAgICAgICAgbG9nLmluZm8oXG4gICAgICAgICAgICAgICAgICAndHJhbnNmb3JtLmpzJyxcbiAgICAgICAgICAgICAgICAgICdGb3VuZCBhIHBvaW50ZXIgY29sdW1uIG5vdCBpbiB0aGUgc2NoZW1hLCBkcm9wcGluZyBpdC4nLFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgbmV3S2V5XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAoc2NoZW1hLmZpZWxkc1tuZXdLZXldLnR5cGUgIT09ICdQb2ludGVyJykge1xuICAgICAgICAgICAgICAgIGxvZy5pbmZvKFxuICAgICAgICAgICAgICAgICAgJ3RyYW5zZm9ybS5qcycsXG4gICAgICAgICAgICAgICAgICAnRm91bmQgYSBwb2ludGVyIGluIGEgbm9uLXBvaW50ZXIgY29sdW1uLCBkcm9wcGluZyBpdC4nLFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAga2V5XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAobW9uZ29PYmplY3Rba2V5XSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJlc3RPYmplY3RbbmV3S2V5XSA9IHRyYW5zZm9ybVBvaW50ZXJTdHJpbmcoc2NoZW1hLCBuZXdLZXksIG1vbmdvT2JqZWN0W2tleV0pO1xuICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoa2V5WzBdID09ICdfJyAmJiBrZXkgIT0gJ19fdHlwZScpIHtcbiAgICAgICAgICAgICAgLy8gVW5yZWNvZ25pemVkIHJlc2VydmVkIGtleTogZHJvcCBpdCBpbnN0ZWFkIG9mIGZhaWxpbmcgdGhlIHJlYWRcbiAgICAgICAgICAgICAgbG9nLndhcm4oJ3RyYW5zZm9ybS5qcycsICdGb3VuZCBhbiB1bmV4cGVjdGVkIHJlc2VydmVkIGtleSwgZHJvcHBpbmcgaXQuJywgY2xhc3NOYW1lLCBrZXkpO1xuICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHZhciB2YWx1ZSA9IG1vbmdvT2JqZWN0W2tleV07XG4gICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICBzY2hlbWEuZmllbGRzW2tleV0gJiZcbiAgICAgICAgICAgICAgICBzY2hlbWEuZmllbGRzW2tleV0udHlwZSA9PT0gJ0ZpbGUnICYmXG4gICAgICAgICAgICAgICAgRmlsZUNvZGVyLmlzVmFsaWREYXRhYmFzZU9iamVjdCh2YWx1ZSlcbiAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgcmVzdE9iamVjdFtrZXldID0gRmlsZUNvZGVyLmRhdGFiYXNlVG9KU09OKHZhbHVlKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1trZXldICYmXG4gICAgICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1trZXldLnR5cGUgPT09ICdHZW9Qb2ludCcgJiZcbiAgICAgICAgICAgICAgICBHZW9Qb2ludENvZGVyLmlzVmFsaWREYXRhYmFzZU9iamVjdCh2YWx1ZSlcbiAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgcmVzdE9iamVjdFtrZXldID0gR2VvUG9pbnRDb2Rlci5kYXRhYmFzZVRvSlNPTih2YWx1ZSk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgIHNjaGVtYS5maWVsZHNba2V5XSAmJlxuICAgICAgICAgICAgICAgIHNjaGVtYS5maWVsZHNba2V5XS50eXBlID09PSAnUG9seWdvbicgJiZcbiAgICAgICAgICAgICAgICBQb2x5Z29uQ29kZXIuaXNWYWxpZERhdGFiYXNlT2JqZWN0KHZhbHVlKVxuICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICByZXN0T2JqZWN0W2tleV0gPSBQb2x5Z29uQ29kZXIuZGF0YWJhc2VUb0pTT04odmFsdWUpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICBzY2hlbWEuZmllbGRzW2tleV0gJiZcbiAgICAgICAgICAgICAgICBzY2hlbWEuZmllbGRzW2tleV0udHlwZSA9PT0gJ0J5dGVzJyAmJlxuICAgICAgICAgICAgICAgIEJ5dGVzQ29kZXIuaXNWYWxpZERhdGFiYXNlT2JqZWN0KHZhbHVlKVxuICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICByZXN0T2JqZWN0W2tleV0gPSBCeXRlc0NvZGVyLmRhdGFiYXNlVG9KU09OKHZhbHVlKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmVzdE9iamVjdFtrZXldID0gbmVzdGVkTW9uZ29PYmplY3RUb05lc3RlZFBhcnNlT2JqZWN0KG1vbmdvT2JqZWN0W2tleV0pO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlbGF0aW9uRmllbGROYW1lcyA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZpbHRlcihcbiAgICAgICAgZmllbGROYW1lID0+IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUmVsYXRpb24nXG4gICAgICApO1xuICAgICAgY29uc3QgcmVsYXRpb25GaWVsZHMgPSB7fTtcbiAgICAgIHJlbGF0aW9uRmllbGROYW1lcy5mb3JFYWNoKHJlbGF0aW9uRmllbGROYW1lID0+IHtcbiAgICAgICAgcmVsYXRpb25GaWVsZHNbcmVsYXRpb25GaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fdHlwZTogJ1JlbGF0aW9uJyxcbiAgICAgICAgICBjbGFzc05hbWU6IHNjaGVtYS5maWVsZHNbcmVsYXRpb25GaWVsZE5hbWVdLnRhcmdldENsYXNzLFxuICAgICAgICB9O1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiB7IC4uLnJlc3RPYmplY3QsIC4uLnJlbGF0aW9uRmllbGRzIH07XG4gICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyAndW5rbm93biBqcyB0eXBlJztcbiAgfVxufTtcblxudmFyIERhdGVDb2RlciA9IHtcbiAgSlNPTlRvRGF0YWJhc2UoanNvbikge1xuICAgIHJldHVybiBuZXcgRGF0ZShqc29uLmlzbyk7XG4gIH0sXG5cbiAgaXNWYWxpZEpTT04odmFsdWUpIHtcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiB2YWx1ZS5fX3R5cGUgPT09ICdEYXRlJztcbiAgfSxcbn07XG5cbnZhciBCeXRlc0NvZGVyID0ge1xuICBiYXNlNjRQYXR0ZXJuOiBuZXcgUmVnRXhwKCdeKD86W0EtWmEtejAtOSsvXXs0fSkqKD86W0EtWmEtejAtOSsvXXsyfT09fFtBLVphLXowLTkrL117M309KT8kJyksXG4gIGlzQmFzZTY0VmFsdWUob2JqZWN0KSB7XG4gICAgaWYgKHR5cGVvZiBvYmplY3QgIT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmJhc2U2NFBhdHRlcm4udGVzdChvYmplY3QpO1xuICB9LFxuXG4gIGRhdGFiYXNlVG9KU09OKG9iamVjdCkge1xuICAgIGxldCB2YWx1ZTtcbiAgICBpZiAodGhpcy5pc0Jhc2U2NFZhbHVlKG9iamVjdCkpIHtcbiAgICAgIHZhbHVlID0gb2JqZWN0O1xuICAgIH0gZWxzZSB7XG4gICAgICB2YWx1ZSA9IG9iamVjdC5idWZmZXIudG9TdHJpbmcoJ2Jhc2U2NCcpO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgX190eXBlOiAnQnl0ZXMnLFxuICAgICAgYmFzZTY0OiB2YWx1ZSxcbiAgICB9O1xuICB9LFxuXG4gIGlzVmFsaWREYXRhYmFzZU9iamVjdChvYmplY3QpIHtcbiAgICByZXR1cm4gb2JqZWN0IGluc3RhbmNlb2YgbW9uZ29kYi5CaW5hcnkgfHwgdGhpcy5pc0Jhc2U2NFZhbHVlKG9iamVjdCk7XG4gIH0sXG5cbiAgSlNPTlRvRGF0YWJhc2UoanNvbikge1xuICAgIHJldHVybiBuZXcgbW9uZ29kYi5CaW5hcnkoQnVmZmVyLmZyb20oanNvbi5iYXNlNjQsICdiYXNlNjQnKSk7XG4gIH0sXG5cbiAgaXNWYWxpZEpTT04odmFsdWUpIHtcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiB2YWx1ZS5fX3R5cGUgPT09ICdCeXRlcyc7XG4gIH0sXG59O1xuXG52YXIgR2VvUG9pbnRDb2RlciA9IHtcbiAgZGF0YWJhc2VUb0pTT04ob2JqZWN0KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIF9fdHlwZTogJ0dlb1BvaW50JyxcbiAgICAgIGxhdGl0dWRlOiBvYmplY3RbMV0sXG4gICAgICBsb25naXR1ZGU6IG9iamVjdFswXSxcbiAgICB9O1xuICB9LFxuXG4gIGlzVmFsaWREYXRhYmFzZU9iamVjdChvYmplY3QpIHtcbiAgICByZXR1cm4gQXJyYXkuaXNBcnJheShvYmplY3QpICYmIG9iamVjdC5sZW5ndGggPT0gMjtcbiAgfSxcblxuICBKU09OVG9EYXRhYmFzZShqc29uKSB7XG4gICAgcmV0dXJuIFtqc29uLmxvbmdpdHVkZSwganNvbi5sYXRpdHVkZV07XG4gIH0sXG5cbiAgaXNWYWxpZEpTT04odmFsdWUpIHtcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiB2YWx1ZS5fX3R5cGUgPT09ICdHZW9Qb2ludCc7XG4gIH0sXG59O1xuXG52YXIgUG9seWdvbkNvZGVyID0ge1xuICBkYXRhYmFzZVRvSlNPTihvYmplY3QpIHtcbiAgICAvLyBDb252ZXJ0IGxuZy9sYXQgLT4gbGF0L2xuZ1xuICAgIGNvbnN0IGNvb3JkcyA9IG9iamVjdC5jb29yZGluYXRlc1swXS5tYXAoY29vcmQgPT4ge1xuICAgICAgcmV0dXJuIFtjb29yZFsxXSwgY29vcmRbMF1dO1xuICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBfX3R5cGU6ICdQb2x5Z29uJyxcbiAgICAgIGNvb3JkaW5hdGVzOiBjb29yZHMsXG4gICAgfTtcbiAgfSxcblxuICBpc1ZhbGlkRGF0YWJhc2VPYmplY3Qob2JqZWN0KSB7XG4gICAgY29uc3QgY29vcmRzID0gb2JqZWN0LmNvb3JkaW5hdGVzWzBdO1xuICAgIGlmIChvYmplY3QudHlwZSAhPT0gJ1BvbHlnb24nIHx8ICFBcnJheS5pc0FycmF5KGNvb3JkcykpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjb29yZHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHBvaW50ID0gY29vcmRzW2ldO1xuICAgICAgaWYgKCFHZW9Qb2ludENvZGVyLmlzVmFsaWREYXRhYmFzZU9iamVjdChwb2ludCkpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBhcnNlRmxvYXQocG9pbnRbMV0pLCBwYXJzZUZsb2F0KHBvaW50WzBdKSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9LFxuXG4gIEpTT05Ub0RhdGFiYXNlKGpzb24pIHtcbiAgICBsZXQgY29vcmRzID0ganNvbi5jb29yZGluYXRlcztcbiAgICAvLyBBZGQgZmlyc3QgcG9pbnQgdG8gdGhlIGVuZCB0byBjbG9zZSBwb2x5Z29uXG4gICAgaWYgKFxuICAgICAgY29vcmRzWzBdWzBdICE9PSBjb29yZHNbY29vcmRzLmxlbmd0aCAtIDFdWzBdIHx8XG4gICAgICBjb29yZHNbMF1bMV0gIT09IGNvb3Jkc1tjb29yZHMubGVuZ3RoIC0gMV1bMV1cbiAgICApIHtcbiAgICAgIGNvb3Jkcy5wdXNoKGNvb3Jkc1swXSk7XG4gICAgfVxuICAgIGNvbnN0IHVuaXF1ZSA9IGNvb3Jkcy5maWx0ZXIoKGl0ZW0sIGluZGV4LCBhcikgPT4ge1xuICAgICAgbGV0IGZvdW5kSW5kZXggPSAtMTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYXIubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgICAgY29uc3QgcHQgPSBhcltpXTtcbiAgICAgICAgaWYgKHB0WzBdID09PSBpdGVtWzBdICYmIHB0WzFdID09PSBpdGVtWzFdKSB7XG4gICAgICAgICAgZm91bmRJbmRleCA9IGk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiBmb3VuZEluZGV4ID09PSBpbmRleDtcbiAgICB9KTtcbiAgICBpZiAodW5pcXVlLmxlbmd0aCA8IDMpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAnR2VvSlNPTjogTG9vcCBtdXN0IGhhdmUgYXQgbGVhc3QgMyBkaWZmZXJlbnQgdmVydGljZXMnXG4gICAgICApO1xuICAgIH1cbiAgICAvLyBDb252ZXJ0IGxhdC9sb25nIC0+IGxvbmcvbGF0XG4gICAgY29vcmRzID0gY29vcmRzLm1hcChjb29yZCA9PiB7XG4gICAgICByZXR1cm4gW2Nvb3JkWzFdLCBjb29yZFswXV07XG4gICAgfSk7XG4gICAgcmV0dXJuIHsgdHlwZTogJ1BvbHlnb24nLCBjb29yZGluYXRlczogW2Nvb3Jkc10gfTtcbiAgfSxcblxuICBpc1ZhbGlkSlNPTih2YWx1ZSkge1xuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIHZhbHVlICE9PSBudWxsICYmIHZhbHVlLl9fdHlwZSA9PT0gJ1BvbHlnb24nO1xuICB9LFxufTtcblxudmFyIEZpbGVDb2RlciA9IHtcbiAgZGF0YWJhc2VUb0pTT04ob2JqZWN0KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIF9fdHlwZTogJ0ZpbGUnLFxuICAgICAgbmFtZTogb2JqZWN0LFxuICAgIH07XG4gIH0sXG5cbiAgaXNWYWxpZERhdGFiYXNlT2JqZWN0KG9iamVjdCkge1xuICAgIHJldHVybiB0eXBlb2Ygb2JqZWN0ID09PSAnc3RyaW5nJztcbiAgfSxcblxuICBKU09OVG9EYXRhYmFzZShqc29uKSB7XG4gICAgcmV0dXJuIGpzb24ubmFtZTtcbiAgfSxcblxuICBpc1ZhbGlkSlNPTih2YWx1ZSkge1xuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIHZhbHVlICE9PSBudWxsICYmIHZhbHVlLl9fdHlwZSA9PT0gJ0ZpbGUnO1xuICB9LFxufTtcblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIHRyYW5zZm9ybUtleSxcbiAgcGFyc2VPYmplY3RUb01vbmdvT2JqZWN0Rm9yQ3JlYXRlLFxuICB0cmFuc2Zvcm1VcGRhdGUsXG4gIHRyYW5zZm9ybVdoZXJlLFxuICBtb25nb09iamVjdFRvUGFyc2VPYmplY3QsXG4gIHRyYW5zZm9ybUNvbnN0cmFpbnQsXG4gIHRyYW5zZm9ybVBvaW50ZXJTdHJpbmcsXG59O1xuIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQUFBLE9BQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLE9BQUEsR0FBQUYsc0JBQUEsQ0FBQUMsT0FBQTtBQUF1QixTQUFBRCx1QkFBQUcsQ0FBQSxXQUFBQSxDQUFBLElBQUFBLENBQUEsQ0FBQUMsVUFBQSxHQUFBRCxDQUFBLEtBQUFFLE9BQUEsRUFBQUYsQ0FBQTtBQUN2QixJQUFJRyxPQUFPLEdBQUdMLE9BQU8sQ0FBQyxTQUFTLENBQUM7QUFDaEMsSUFBSU0sS0FBSyxHQUFHTixPQUFPLENBQUMsWUFBWSxDQUFDLENBQUNNLEtBQUs7QUFDdkMsTUFBTUMsS0FBSyxHQUFHUCxPQUFPLENBQUMsZ0JBQWdCLENBQUM7QUFFdkMsTUFBTVEsWUFBWSxHQUFHQSxDQUFDQyxTQUFTLEVBQUVDLFNBQVMsRUFBRUMsTUFBTSxLQUFLO0VBQ3JEO0VBQ0EsUUFBUUQsU0FBUztJQUNmLEtBQUssVUFBVTtNQUNiLE9BQU8sS0FBSztJQUNkLEtBQUssV0FBVztNQUNkLE9BQU8sYUFBYTtJQUN0QixLQUFLLFdBQVc7TUFDZCxPQUFPLGFBQWE7SUFDdEIsS0FBSyxjQUFjO01BQ2pCLE9BQU8sZ0JBQWdCO0lBQ3pCLEtBQUssVUFBVTtNQUNiLE9BQU8sWUFBWTtJQUNyQixLQUFLLFdBQVc7TUFDZCxPQUFPLFlBQVk7RUFDdkI7RUFFQSxJQUFJQyxNQUFNLENBQUNDLE1BQU0sQ0FBQ0YsU0FBUyxDQUFDLElBQUlDLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDRixTQUFTLENBQUMsQ0FBQ0csTUFBTSxJQUFJLFNBQVMsRUFBRTtJQUM1RUgsU0FBUyxHQUFHLEtBQUssR0FBR0EsU0FBUztFQUMvQixDQUFDLE1BQU0sSUFBSUMsTUFBTSxDQUFDQyxNQUFNLENBQUNGLFNBQVMsQ0FBQyxJQUFJQyxNQUFNLENBQUNDLE1BQU0sQ0FBQ0YsU0FBUyxDQUFDLENBQUNJLElBQUksSUFBSSxTQUFTLEVBQUU7SUFDakZKLFNBQVMsR0FBRyxLQUFLLEdBQUdBLFNBQVM7RUFDL0I7RUFFQSxPQUFPQSxTQUFTO0FBQ2xCLENBQUM7QUFFRCxNQUFNSywwQkFBMEIsR0FBR0EsQ0FBQ04sU0FBUyxFQUFFTyxPQUFPLEVBQUVDLFNBQVMsRUFBRUMsaUJBQWlCLEtBQUs7RUFDdkY7RUFDQSxJQUFJQyxHQUFHLEdBQUdILE9BQU87RUFDakIsSUFBSUksU0FBUyxHQUFHLEtBQUs7RUFDckIsUUFBUUQsR0FBRztJQUNULEtBQUssVUFBVTtJQUNmLEtBQUssS0FBSztNQUNSLElBQUksQ0FBQyxlQUFlLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQ0UsUUFBUSxDQUFDWixTQUFTLENBQUMsRUFBRTtRQUMzRCxPQUFPO1VBQ0xVLEdBQUcsRUFBRUEsR0FBRztVQUNSRyxLQUFLLEVBQUVDLFFBQVEsQ0FBQ04sU0FBUztRQUMzQixDQUFDO01BQ0g7TUFDQUUsR0FBRyxHQUFHLEtBQUs7TUFDWDtJQUNGLEtBQUssV0FBVztJQUNoQixLQUFLLGFBQWE7TUFDaEJBLEdBQUcsR0FBRyxhQUFhO01BQ25CQyxTQUFTLEdBQUcsSUFBSTtNQUNoQjtJQUNGLEtBQUssV0FBVztJQUNoQixLQUFLLGFBQWE7TUFDaEJELEdBQUcsR0FBRyxhQUFhO01BQ25CQyxTQUFTLEdBQUcsSUFBSTtNQUNoQjtJQUNGLEtBQUssY0FBYztJQUNuQixLQUFLLGdCQUFnQjtNQUNuQkQsR0FBRyxHQUFHLGdCQUFnQjtNQUN0QjtJQUNGLEtBQUssV0FBVztJQUNoQixLQUFLLFlBQVk7TUFDZkEsR0FBRyxHQUFHLFdBQVc7TUFDakJDLFNBQVMsR0FBRyxJQUFJO01BQ2hCO0lBQ0YsS0FBSyxnQ0FBZ0M7TUFDbkNELEdBQUcsR0FBRyxnQ0FBZ0M7TUFDdENDLFNBQVMsR0FBRyxJQUFJO01BQ2hCO0lBQ0YsS0FBSyw2QkFBNkI7TUFDaENELEdBQUcsR0FBRyw2QkFBNkI7TUFDbkNDLFNBQVMsR0FBRyxJQUFJO01BQ2hCO0lBQ0YsS0FBSyxxQkFBcUI7TUFDeEJELEdBQUcsR0FBRyxxQkFBcUI7TUFDM0I7SUFDRixLQUFLLDhCQUE4QjtNQUNqQ0EsR0FBRyxHQUFHLDhCQUE4QjtNQUNwQ0MsU0FBUyxHQUFHLElBQUk7TUFDaEI7SUFDRixLQUFLLHNCQUFzQjtNQUN6QkQsR0FBRyxHQUFHLHNCQUFzQjtNQUM1QkMsU0FBUyxHQUFHLElBQUk7TUFDaEI7SUFDRixLQUFLLFFBQVE7SUFDYixLQUFLLFFBQVE7TUFDWCxPQUFPO1FBQUVELEdBQUcsRUFBRUEsR0FBRztRQUFFRyxLQUFLLEVBQUVMO01BQVUsQ0FBQztJQUN2QyxLQUFLLFVBQVU7SUFDZixLQUFLLFlBQVk7TUFDZkUsR0FBRyxHQUFHLFlBQVk7TUFDbEJDLFNBQVMsR0FBRyxJQUFJO01BQ2hCO0lBQ0YsS0FBSyxXQUFXO0lBQ2hCLEtBQUssWUFBWTtNQUNmRCxHQUFHLEdBQUcsWUFBWTtNQUNsQkMsU0FBUyxHQUFHLElBQUk7TUFDaEI7RUFDSjtFQUVBLElBQ0dGLGlCQUFpQixDQUFDTixNQUFNLENBQUNPLEdBQUcsQ0FBQyxJQUFJRCxpQkFBaUIsQ0FBQ04sTUFBTSxDQUFDTyxHQUFHLENBQUMsQ0FBQ0wsSUFBSSxLQUFLLFNBQVMsSUFDakYsQ0FBQ0ssR0FBRyxDQUFDRSxRQUFRLENBQUMsR0FBRyxDQUFDLElBQ2pCLENBQUNILGlCQUFpQixDQUFDTixNQUFNLENBQUNPLEdBQUcsQ0FBQyxJQUM5QkYsU0FBUyxJQUNUQSxTQUFTLENBQUNKLE1BQU0sSUFBSSxTQUFVLENBQUM7RUFBQSxFQUNqQztJQUNBTSxHQUFHLEdBQUcsS0FBSyxHQUFHQSxHQUFHO0VBQ25COztFQUVBO0VBQ0EsSUFBSUcsS0FBSyxHQUFHRSxxQkFBcUIsQ0FBQ1AsU0FBUyxDQUFDO0VBQzVDLElBQUlLLEtBQUssS0FBS0csZUFBZSxFQUFFO0lBQzdCLElBQUlMLFNBQVMsSUFBSSxPQUFPRSxLQUFLLEtBQUssUUFBUSxFQUFFO01BQzFDQSxLQUFLLEdBQUcsSUFBSUksSUFBSSxDQUFDSixLQUFLLENBQUM7SUFDekI7SUFDQSxJQUFJTixPQUFPLENBQUNXLE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUU7TUFDNUIsT0FBTztRQUFFUixHQUFHO1FBQUVHLEtBQUssRUFBRUw7TUFBVSxDQUFDO0lBQ2xDO0lBQ0EsT0FBTztNQUFFRSxHQUFHO01BQUVHO0lBQU0sQ0FBQztFQUN2Qjs7RUFFQTtFQUNBLElBQUlNLEtBQUssQ0FBQ0MsT0FBTyxDQUFDWixTQUFTLENBQUMsRUFBRTtJQUM1QkssS0FBSyxHQUFHTCxTQUFTLENBQUNhLEdBQUcsQ0FBQ0Msc0JBQXNCLENBQUM7SUFDN0MsT0FBTztNQUFFWixHQUFHO01BQUVHO0lBQU0sQ0FBQztFQUN2Qjs7RUFFQTtFQUNBLElBQUksT0FBT0wsU0FBUyxLQUFLLFFBQVEsSUFBSSxNQUFNLElBQUlBLFNBQVMsRUFBRTtJQUN4RCxPQUFPO01BQUVFLEdBQUc7TUFBRUcsS0FBSyxFQUFFVSx1QkFBdUIsQ0FBQ2YsU0FBUyxFQUFFLEtBQUs7SUFBRSxDQUFDO0VBQ2xFOztFQUVBO0VBQ0FLLEtBQUssR0FBR1csU0FBUyxDQUFDaEIsU0FBUyxFQUFFYyxzQkFBc0IsQ0FBQztFQUNwRCxPQUFPO0lBQUVaLEdBQUc7SUFBRUc7RUFBTSxDQUFDO0FBQ3ZCLENBQUM7QUFFRCxNQUFNWSxPQUFPLEdBQUdaLEtBQUssSUFBSTtFQUN2QixPQUFPQSxLQUFLLElBQUlmLEtBQUssQ0FBQzRCLFFBQVEsQ0FBQ2IsS0FBSyxDQUFDO0FBQ3ZDLENBQUM7QUFFRCxNQUFNYyxpQkFBaUIsR0FBR2QsS0FBSyxJQUFJO0VBQ2pDLElBQUksQ0FBQ1ksT0FBTyxDQUFDWixLQUFLLENBQUMsRUFBRTtJQUNuQixPQUFPLEtBQUs7RUFDZDtFQUVBLE1BQU1lLE9BQU8sR0FBR2YsS0FBSyxDQUFDZ0IsUUFBUSxDQUFDLENBQUMsQ0FBQ0MsS0FBSyxDQUFDLGdCQUFnQixDQUFDO0VBQ3hELE9BQU8sQ0FBQyxDQUFDRixPQUFPO0FBQ2xCLENBQUM7QUFFRCxNQUFNRyxzQkFBc0IsR0FBR0MsTUFBTSxJQUFJO0VBQ3ZDLElBQUksQ0FBQ0EsTUFBTSxJQUFJLENBQUNiLEtBQUssQ0FBQ0MsT0FBTyxDQUFDWSxNQUFNLENBQUMsSUFBSUEsTUFBTSxDQUFDQyxNQUFNLEtBQUssQ0FBQyxFQUFFO0lBQzVELE9BQU8sSUFBSTtFQUNiO0VBRUEsTUFBTUMsa0JBQWtCLEdBQUdQLGlCQUFpQixDQUFDSyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7RUFDdkQsSUFBSUEsTUFBTSxDQUFDQyxNQUFNLEtBQUssQ0FBQyxFQUFFO0lBQ3ZCLE9BQU9DLGtCQUFrQjtFQUMzQjtFQUVBLEtBQUssSUFBSUMsQ0FBQyxHQUFHLENBQUMsRUFBRUYsTUFBTSxHQUFHRCxNQUFNLENBQUNDLE1BQU0sRUFBRUUsQ0FBQyxHQUFHRixNQUFNLEVBQUUsRUFBRUUsQ0FBQyxFQUFFO0lBQ3ZELElBQUlELGtCQUFrQixLQUFLUCxpQkFBaUIsQ0FBQ0ssTUFBTSxDQUFDRyxDQUFDLENBQUMsQ0FBQyxFQUFFO01BQ3ZELE9BQU8sS0FBSztJQUNkO0VBQ0Y7RUFFQSxPQUFPLElBQUk7QUFDYixDQUFDO0FBRUQsTUFBTUMsZUFBZSxHQUFHSixNQUFNLElBQUk7RUFDaEMsT0FBT0EsTUFBTSxDQUFDSyxJQUFJLENBQUMsVUFBVXhCLEtBQUssRUFBRTtJQUNsQyxPQUFPWSxPQUFPLENBQUNaLEtBQUssQ0FBQztFQUN2QixDQUFDLENBQUM7QUFDSixDQUFDO0FBRUQsTUFBTVMsc0JBQXNCLEdBQUdkLFNBQVMsSUFBSTtFQUMxQyxJQUNFQSxTQUFTLEtBQUssSUFBSSxJQUNsQixPQUFPQSxTQUFTLEtBQUssUUFBUSxJQUM3QjhCLE1BQU0sQ0FBQ0MsSUFBSSxDQUFDL0IsU0FBUyxDQUFDLENBQUM2QixJQUFJLENBQUMzQixHQUFHLElBQUlBLEdBQUcsQ0FBQ0UsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJRixHQUFHLENBQUNFLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUMxRTtJQUNBLE1BQU0sSUFBSWYsS0FBSyxDQUFDMkMsS0FBSyxDQUNuQjNDLEtBQUssQ0FBQzJDLEtBQUssQ0FBQ0Msa0JBQWtCLEVBQzlCLDBEQUNGLENBQUM7RUFDSDtFQUNBO0VBQ0EsSUFBSTVCLEtBQUssR0FBRzZCLHFCQUFxQixDQUFDbEMsU0FBUyxDQUFDO0VBQzVDLElBQUlLLEtBQUssS0FBS0csZUFBZSxFQUFFO0lBQzdCLElBQUlILEtBQUssSUFBSSxPQUFPQSxLQUFLLEtBQUssUUFBUSxFQUFFO01BQ3RDLElBQUlmLEtBQUssQ0FBQzZDLE1BQU0sQ0FBQzlCLEtBQUssQ0FBQyxFQUFFO1FBQ3ZCLE9BQU9BLEtBQUs7TUFDZDtNQUNBLElBQUlNLEtBQUssQ0FBQ0MsT0FBTyxDQUFDUCxLQUFLLENBQUMsRUFBRTtRQUN4QkEsS0FBSyxHQUFHQSxLQUFLLENBQUNRLEdBQUcsQ0FBQ0Msc0JBQXNCLENBQUM7TUFDM0MsQ0FBQyxNQUFNO1FBQ0xULEtBQUssR0FBR1csU0FBUyxDQUFDWCxLQUFLLEVBQUVTLHNCQUFzQixDQUFDO01BQ2xEO0lBQ0Y7SUFDQSxPQUFPVCxLQUFLO0VBQ2Q7O0VBRUE7RUFDQSxJQUFJTSxLQUFLLENBQUNDLE9BQU8sQ0FBQ1osU0FBUyxDQUFDLEVBQUU7SUFDNUIsT0FBT0EsU0FBUyxDQUFDYSxHQUFHLENBQUNDLHNCQUFzQixDQUFDO0VBQzlDOztFQUVBO0VBQ0EsSUFBSSxPQUFPZCxTQUFTLEtBQUssUUFBUSxJQUFJLE1BQU0sSUFBSUEsU0FBUyxFQUFFO0lBQ3hELE9BQU9lLHVCQUF1QixDQUFDZixTQUFTLEVBQUUsSUFBSSxDQUFDO0VBQ2pEOztFQUVBO0VBQ0EsT0FBT2dCLFNBQVMsQ0FBQ2hCLFNBQVMsRUFBRWMsc0JBQXNCLENBQUM7QUFDckQsQ0FBQztBQUVELE1BQU1zQixXQUFXLEdBQUcvQixLQUFLLElBQUk7RUFDM0IsSUFBSSxPQUFPQSxLQUFLLEtBQUssUUFBUSxFQUFFO0lBQzdCLE9BQU8sSUFBSUksSUFBSSxDQUFDSixLQUFLLENBQUM7RUFDeEIsQ0FBQyxNQUFNLElBQUlmLEtBQUssQ0FBQzZDLE1BQU0sQ0FBQzlCLEtBQUssQ0FBQyxFQUFFO0lBQzlCLE9BQU9BLEtBQUs7RUFDZDtFQUNBLE9BQU8sS0FBSztBQUNkLENBQUM7QUFFRCxTQUFTZ0Msc0JBQXNCQSxDQUFDN0MsU0FBUyxFQUFFVSxHQUFHLEVBQUVHLEtBQUssRUFBRVgsTUFBTSxFQUFFNEMsS0FBSyxHQUFHLEtBQUssRUFBRTtFQUM1RSxRQUFRcEMsR0FBRztJQUNULEtBQUssV0FBVztNQUNkLElBQUlrQyxXQUFXLENBQUMvQixLQUFLLENBQUMsRUFBRTtRQUN0QixPQUFPO1VBQUVILEdBQUcsRUFBRSxhQUFhO1VBQUVHLEtBQUssRUFBRStCLFdBQVcsQ0FBQy9CLEtBQUs7UUFBRSxDQUFDO01BQzFEO01BQ0FILEdBQUcsR0FBRyxhQUFhO01BQ25CO0lBQ0YsS0FBSyxXQUFXO01BQ2QsSUFBSWtDLFdBQVcsQ0FBQy9CLEtBQUssQ0FBQyxFQUFFO1FBQ3RCLE9BQU87VUFBRUgsR0FBRyxFQUFFLGFBQWE7VUFBRUcsS0FBSyxFQUFFK0IsV0FBVyxDQUFDL0IsS0FBSztRQUFFLENBQUM7TUFDMUQ7TUFDQUgsR0FBRyxHQUFHLGFBQWE7TUFDbkI7SUFDRixLQUFLLFdBQVc7TUFDZCxJQUFJa0MsV0FBVyxDQUFDL0IsS0FBSyxDQUFDLEVBQUU7UUFDdEIsT0FBTztVQUFFSCxHQUFHLEVBQUUsV0FBVztVQUFFRyxLQUFLLEVBQUUrQixXQUFXLENBQUMvQixLQUFLO1FBQUUsQ0FBQztNQUN4RDtNQUNBO0lBQ0YsS0FBSyxnQ0FBZ0M7TUFDbkMsSUFBSStCLFdBQVcsQ0FBQy9CLEtBQUssQ0FBQyxFQUFFO1FBQ3RCLE9BQU87VUFDTEgsR0FBRyxFQUFFLGdDQUFnQztVQUNyQ0csS0FBSyxFQUFFK0IsV0FBVyxDQUFDL0IsS0FBSztRQUMxQixDQUFDO01BQ0g7TUFDQTtJQUNGLEtBQUssVUFBVTtNQUFFO1FBQ2YsSUFBSSxDQUFDLGVBQWUsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDRCxRQUFRLENBQUNaLFNBQVMsQ0FBQyxFQUFFO1VBQzNEYSxLQUFLLEdBQUdDLFFBQVEsQ0FBQ0QsS0FBSyxDQUFDO1FBQ3pCO1FBQ0EsT0FBTztVQUFFSCxHQUFHLEVBQUUsS0FBSztVQUFFRztRQUFNLENBQUM7TUFDOUI7SUFDQSxLQUFLLDZCQUE2QjtNQUNoQyxJQUFJK0IsV0FBVyxDQUFDL0IsS0FBSyxDQUFDLEVBQUU7UUFDdEIsT0FBTztVQUNMSCxHQUFHLEVBQUUsNkJBQTZCO1VBQ2xDRyxLQUFLLEVBQUUrQixXQUFXLENBQUMvQixLQUFLO1FBQzFCLENBQUM7TUFDSDtNQUNBO0lBQ0YsS0FBSyxxQkFBcUI7TUFDeEIsT0FBTztRQUFFSCxHQUFHO1FBQUVHO01BQU0sQ0FBQztJQUN2QixLQUFLLGNBQWM7TUFDakIsT0FBTztRQUFFSCxHQUFHLEVBQUUsZ0JBQWdCO1FBQUVHO01BQU0sQ0FBQztJQUN6QyxLQUFLLDhCQUE4QjtNQUNqQyxJQUFJK0IsV0FBVyxDQUFDL0IsS0FBSyxDQUFDLEVBQUU7UUFDdEIsT0FBTztVQUNMSCxHQUFHLEVBQUUsOEJBQThCO1VBQ25DRyxLQUFLLEVBQUUrQixXQUFXLENBQUMvQixLQUFLO1FBQzFCLENBQUM7TUFDSDtNQUNBO0lBQ0YsS0FBSyxzQkFBc0I7TUFDekIsSUFBSStCLFdBQVcsQ0FBQy9CLEtBQUssQ0FBQyxFQUFFO1FBQ3RCLE9BQU87VUFBRUgsR0FBRyxFQUFFLHNCQUFzQjtVQUFFRyxLQUFLLEVBQUUrQixXQUFXLENBQUMvQixLQUFLO1FBQUUsQ0FBQztNQUNuRTtNQUNBO0lBQ0YsS0FBSyxRQUFRO0lBQ2IsS0FBSyxRQUFRO0lBQ2IsS0FBSyxtQkFBbUI7SUFDeEIsS0FBSyxxQkFBcUI7TUFDeEIsT0FBTztRQUFFSCxHQUFHO1FBQUVHO01BQU0sQ0FBQztJQUN2QixLQUFLLEtBQUs7SUFDVixLQUFLLE1BQU07SUFDWCxLQUFLLE1BQU07TUFDVCxPQUFPO1FBQ0xILEdBQUcsRUFBRUEsR0FBRztRQUNSRyxLQUFLLEVBQUVBLEtBQUssQ0FBQ1EsR0FBRyxDQUFDMEIsUUFBUSxJQUFJQyxjQUFjLENBQUNoRCxTQUFTLEVBQUUrQyxRQUFRLEVBQUU3QyxNQUFNLEVBQUU0QyxLQUFLLENBQUM7TUFDakYsQ0FBQztJQUNILEtBQUssVUFBVTtNQUNiLElBQUlGLFdBQVcsQ0FBQy9CLEtBQUssQ0FBQyxFQUFFO1FBQ3RCLE9BQU87VUFBRUgsR0FBRyxFQUFFLFlBQVk7VUFBRUcsS0FBSyxFQUFFK0IsV0FBVyxDQUFDL0IsS0FBSztRQUFFLENBQUM7TUFDekQ7TUFDQUgsR0FBRyxHQUFHLFlBQVk7TUFDbEI7SUFDRixLQUFLLFdBQVc7TUFDZCxPQUFPO1FBQUVBLEdBQUcsRUFBRSxZQUFZO1FBQUVHLEtBQUssRUFBRUE7TUFBTSxDQUFDO0lBQzVDO01BQVM7UUFDUDtRQUNBLE1BQU1vQyxhQUFhLEdBQUd2QyxHQUFHLENBQUNvQixLQUFLLENBQUMsc0NBQXNDLENBQUM7UUFDdkUsSUFBSW1CLGFBQWEsSUFBSWpELFNBQVMsS0FBSyxPQUFPLEVBQUU7VUFDMUMsTUFBTWtELFFBQVEsR0FBR0QsYUFBYSxDQUFDLENBQUMsQ0FBQztVQUNqQyxNQUFNRSxRQUFRLEdBQUdGLGFBQWEsQ0FBQyxDQUFDLENBQUM7VUFDakMsT0FBTztZQUFFdkMsR0FBRyxFQUFFLGNBQWN3QyxRQUFRLEdBQUdDLFFBQVEsR0FBRyxJQUFJQSxRQUFRLEVBQUUsR0FBRyxFQUFFLEVBQUU7WUFBRXRDO1VBQU0sQ0FBQztRQUNsRjtNQUNGO0VBQ0Y7RUFFQSxNQUFNdUMsbUJBQW1CLEdBQUdsRCxNQUFNLElBQUlBLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDTyxHQUFHLENBQUMsSUFBSVIsTUFBTSxDQUFDQyxNQUFNLENBQUNPLEdBQUcsQ0FBQyxDQUFDTCxJQUFJLEtBQUssT0FBTztFQUUvRixNQUFNZ0QscUJBQXFCLEdBQ3pCbkQsTUFBTSxJQUFJQSxNQUFNLENBQUNDLE1BQU0sQ0FBQ08sR0FBRyxDQUFDLElBQUlSLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDTyxHQUFHLENBQUMsQ0FBQ0wsSUFBSSxLQUFLLFNBQVM7RUFFdkUsTUFBTWlELEtBQUssR0FBR3BELE1BQU0sSUFBSUEsTUFBTSxDQUFDQyxNQUFNLENBQUNPLEdBQUcsQ0FBQztFQUMxQyxJQUNFMkMscUJBQXFCLElBQ3BCLENBQUNuRCxNQUFNLElBQUksQ0FBQ1EsR0FBRyxDQUFDRSxRQUFRLENBQUMsR0FBRyxDQUFDLElBQUlDLEtBQUssSUFBSUEsS0FBSyxDQUFDVCxNQUFNLEtBQUssU0FBVSxFQUN0RTtJQUNBTSxHQUFHLEdBQUcsS0FBSyxHQUFHQSxHQUFHO0VBQ25COztFQUVBO0VBQ0EsTUFBTTZDLHFCQUFxQixHQUFHQyxtQkFBbUIsQ0FBQzNDLEtBQUssRUFBRXlDLEtBQUssRUFBRTVDLEdBQUcsRUFBRW9DLEtBQUssQ0FBQztFQUMzRSxJQUFJUyxxQkFBcUIsS0FBS3ZDLGVBQWUsRUFBRTtJQUM3QyxJQUFJdUMscUJBQXFCLENBQUNFLEtBQUssRUFBRTtNQUMvQixPQUFPO1FBQUUvQyxHQUFHLEVBQUUsT0FBTztRQUFFRyxLQUFLLEVBQUUwQyxxQkFBcUIsQ0FBQ0U7TUFBTSxDQUFDO0lBQzdEO0lBQ0EsSUFBSUYscUJBQXFCLENBQUNHLFVBQVUsRUFBRTtNQUNwQyxPQUFPO1FBQUVoRCxHQUFHLEVBQUUsTUFBTTtRQUFFRyxLQUFLLEVBQUUsQ0FBQztVQUFFLENBQUNILEdBQUcsR0FBRzZDO1FBQXNCLENBQUM7TUFBRSxDQUFDO0lBQ25FO0lBQ0EsT0FBTztNQUFFN0MsR0FBRztNQUFFRyxLQUFLLEVBQUUwQztJQUFzQixDQUFDO0VBQzlDO0VBRUEsSUFBSUgsbUJBQW1CLElBQUksQ0FBQ2pDLEtBQUssQ0FBQ0MsT0FBTyxDQUFDUCxLQUFLLENBQUMsRUFBRTtJQUNoRCxPQUFPO01BQUVILEdBQUc7TUFBRUcsS0FBSyxFQUFFO1FBQUU4QyxJQUFJLEVBQUUsQ0FBQ2pCLHFCQUFxQixDQUFDN0IsS0FBSyxDQUFDO01BQUU7SUFBRSxDQUFDO0VBQ2pFOztFQUVBO0VBQ0EsTUFBTStDLFlBQVksR0FBR2xELEdBQUcsQ0FBQ0UsUUFBUSxDQUFDLEdBQUcsQ0FBQyxHQUNsQzhCLHFCQUFxQixDQUFDN0IsS0FBSyxDQUFDLEdBQzVCRSxxQkFBcUIsQ0FBQ0YsS0FBSyxDQUFDO0VBQ2hDLElBQUkrQyxZQUFZLEtBQUs1QyxlQUFlLEVBQUU7SUFDcEMsT0FBTztNQUFFTixHQUFHO01BQUVHLEtBQUssRUFBRStDO0lBQWEsQ0FBQztFQUNyQyxDQUFDLE1BQU07SUFDTCxNQUFNLElBQUkvRCxLQUFLLENBQUMyQyxLQUFLLENBQ25CM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUN4QixrQkFBa0JoRCxLQUFLLHdCQUN6QixDQUFDO0VBQ0g7QUFDRjs7QUFFQTtBQUNBO0FBQ0E7QUFDQSxTQUFTbUMsY0FBY0EsQ0FBQ2hELFNBQVMsRUFBRThELFNBQVMsRUFBRTVELE1BQU0sRUFBRTRDLEtBQUssR0FBRyxLQUFLLEVBQUU7RUFDbkUsTUFBTWlCLFVBQVUsR0FBRyxDQUFDLENBQUM7RUFDckIsS0FBSyxNQUFNeEQsT0FBTyxJQUFJdUQsU0FBUyxFQUFFO0lBQy9CLE1BQU1FLEdBQUcsR0FBR25CLHNCQUFzQixDQUFDN0MsU0FBUyxFQUFFTyxPQUFPLEVBQUV1RCxTQUFTLENBQUN2RCxPQUFPLENBQUMsRUFBRUwsTUFBTSxFQUFFNEMsS0FBSyxDQUFDO0lBQ3pGaUIsVUFBVSxDQUFDQyxHQUFHLENBQUN0RCxHQUFHLENBQUMsR0FBR3NELEdBQUcsQ0FBQ25ELEtBQUs7RUFDakM7RUFDQSxPQUFPa0QsVUFBVTtBQUNuQjtBQUVBLE1BQU1FLHdDQUF3QyxHQUFHQSxDQUFDMUQsT0FBTyxFQUFFQyxTQUFTLEVBQUVOLE1BQU0sS0FBSztFQUMvRTtFQUNBLElBQUlnRSxnQkFBZ0I7RUFDcEIsSUFBSUMsYUFBYTtFQUNqQixRQUFRNUQsT0FBTztJQUNiLEtBQUssVUFBVTtNQUNiLE9BQU87UUFBRUcsR0FBRyxFQUFFLEtBQUs7UUFBRUcsS0FBSyxFQUFFTDtNQUFVLENBQUM7SUFDekMsS0FBSyxXQUFXO01BQ2QwRCxnQkFBZ0IsR0FBR25ELHFCQUFxQixDQUFDUCxTQUFTLENBQUM7TUFDbkQyRCxhQUFhLEdBQ1gsT0FBT0QsZ0JBQWdCLEtBQUssUUFBUSxHQUFHLElBQUlqRCxJQUFJLENBQUNpRCxnQkFBZ0IsQ0FBQyxHQUFHQSxnQkFBZ0I7TUFDdEYsT0FBTztRQUFFeEQsR0FBRyxFQUFFLFdBQVc7UUFBRUcsS0FBSyxFQUFFc0Q7TUFBYyxDQUFDO0lBQ25ELEtBQUssZ0NBQWdDO01BQ25DRCxnQkFBZ0IsR0FBR25ELHFCQUFxQixDQUFDUCxTQUFTLENBQUM7TUFDbkQyRCxhQUFhLEdBQ1gsT0FBT0QsZ0JBQWdCLEtBQUssUUFBUSxHQUFHLElBQUlqRCxJQUFJLENBQUNpRCxnQkFBZ0IsQ0FBQyxHQUFHQSxnQkFBZ0I7TUFDdEYsT0FBTztRQUFFeEQsR0FBRyxFQUFFLGdDQUFnQztRQUFFRyxLQUFLLEVBQUVzRDtNQUFjLENBQUM7SUFDeEUsS0FBSyw2QkFBNkI7TUFDaENELGdCQUFnQixHQUFHbkQscUJBQXFCLENBQUNQLFNBQVMsQ0FBQztNQUNuRDJELGFBQWEsR0FDWCxPQUFPRCxnQkFBZ0IsS0FBSyxRQUFRLEdBQUcsSUFBSWpELElBQUksQ0FBQ2lELGdCQUFnQixDQUFDLEdBQUdBLGdCQUFnQjtNQUN0RixPQUFPO1FBQUV4RCxHQUFHLEVBQUUsNkJBQTZCO1FBQUVHLEtBQUssRUFBRXNEO01BQWMsQ0FBQztJQUNyRSxLQUFLLDhCQUE4QjtNQUNqQ0QsZ0JBQWdCLEdBQUduRCxxQkFBcUIsQ0FBQ1AsU0FBUyxDQUFDO01BQ25EMkQsYUFBYSxHQUNYLE9BQU9ELGdCQUFnQixLQUFLLFFBQVEsR0FBRyxJQUFJakQsSUFBSSxDQUFDaUQsZ0JBQWdCLENBQUMsR0FBR0EsZ0JBQWdCO01BQ3RGLE9BQU87UUFBRXhELEdBQUcsRUFBRSw4QkFBOEI7UUFBRUcsS0FBSyxFQUFFc0Q7TUFBYyxDQUFDO0lBQ3RFLEtBQUssc0JBQXNCO01BQ3pCRCxnQkFBZ0IsR0FBR25ELHFCQUFxQixDQUFDUCxTQUFTLENBQUM7TUFDbkQyRCxhQUFhLEdBQ1gsT0FBT0QsZ0JBQWdCLEtBQUssUUFBUSxHQUFHLElBQUlqRCxJQUFJLENBQUNpRCxnQkFBZ0IsQ0FBQyxHQUFHQSxnQkFBZ0I7TUFDdEYsT0FBTztRQUFFeEQsR0FBRyxFQUFFLHNCQUFzQjtRQUFFRyxLQUFLLEVBQUVzRDtNQUFjLENBQUM7SUFDOUQsS0FBSyxxQkFBcUI7SUFDMUIsS0FBSyxRQUFRO0lBQ2IsS0FBSyxRQUFRO0lBQ2IsS0FBSyxxQkFBcUI7SUFDMUIsS0FBSyxrQkFBa0I7SUFDdkIsS0FBSyxtQkFBbUI7TUFDdEIsT0FBTztRQUFFekQsR0FBRyxFQUFFSCxPQUFPO1FBQUVNLEtBQUssRUFBRUw7TUFBVSxDQUFDO0lBQzNDLEtBQUssY0FBYztNQUNqQixPQUFPO1FBQUVFLEdBQUcsRUFBRSxnQkFBZ0I7UUFBRUcsS0FBSyxFQUFFTDtNQUFVLENBQUM7SUFDcEQ7TUFDRTtNQUNBLElBQUlELE9BQU8sQ0FBQ3VCLEtBQUssQ0FBQyxpQ0FBaUMsQ0FBQyxFQUFFO1FBQ3BELE1BQU0sSUFBSWpDLEtBQUssQ0FBQzJDLEtBQUssQ0FBQzNDLEtBQUssQ0FBQzJDLEtBQUssQ0FBQzRCLGdCQUFnQixFQUFFLG9CQUFvQixHQUFHN0QsT0FBTyxDQUFDO01BQ3JGO01BQ0E7TUFDQSxJQUFJQSxPQUFPLENBQUN1QixLQUFLLENBQUMsNEJBQTRCLENBQUMsRUFBRTtRQUMvQyxPQUFPO1VBQUVwQixHQUFHLEVBQUVILE9BQU87VUFBRU0sS0FBSyxFQUFFTDtRQUFVLENBQUM7TUFDM0M7RUFDSjtFQUNBO0VBQ0EsSUFBSUEsU0FBUyxJQUFJQSxTQUFTLENBQUNKLE1BQU0sS0FBSyxPQUFPLEVBQUU7SUFDN0M7SUFDQTtJQUNBLElBQ0dGLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDSSxPQUFPLENBQUMsSUFBSUwsTUFBTSxDQUFDQyxNQUFNLENBQUNJLE9BQU8sQ0FBQyxDQUFDRixJQUFJLElBQUksU0FBUyxJQUNuRUcsU0FBUyxDQUFDSixNQUFNLElBQUksU0FBUyxFQUM3QjtNQUNBRyxPQUFPLEdBQUcsS0FBSyxHQUFHQSxPQUFPO0lBQzNCO0VBQ0Y7O0VBRUE7RUFDQSxJQUFJTSxLQUFLLEdBQUdFLHFCQUFxQixDQUFDUCxTQUFTLENBQUM7RUFDNUMsSUFBSUssS0FBSyxLQUFLRyxlQUFlLEVBQUU7SUFDN0IsT0FBTztNQUFFTixHQUFHLEVBQUVILE9BQU87TUFBRU0sS0FBSyxFQUFFQTtJQUFNLENBQUM7RUFDdkM7O0VBRUE7RUFDQTtFQUNBLElBQUlOLE9BQU8sS0FBSyxLQUFLLEVBQUU7SUFDckIsTUFBTSwwQ0FBMEM7RUFDbEQ7O0VBRUE7RUFDQSxJQUFJWSxLQUFLLENBQUNDLE9BQU8sQ0FBQ1osU0FBUyxDQUFDLEVBQUU7SUFDNUJLLEtBQUssR0FBR0wsU0FBUyxDQUFDYSxHQUFHLENBQUNDLHNCQUFzQixDQUFDO0lBQzdDLE9BQU87TUFBRVosR0FBRyxFQUFFSCxPQUFPO01BQUVNLEtBQUssRUFBRUE7SUFBTSxDQUFDO0VBQ3ZDOztFQUVBO0VBQ0EsSUFBSXlCLE1BQU0sQ0FBQ0MsSUFBSSxDQUFDL0IsU0FBUyxDQUFDLENBQUM2QixJQUFJLENBQUMzQixHQUFHLElBQUlBLEdBQUcsQ0FBQ0UsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJRixHQUFHLENBQUNFLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFO0lBQzlFLE1BQU0sSUFBSWYsS0FBSyxDQUFDMkMsS0FBSyxDQUNuQjNDLEtBQUssQ0FBQzJDLEtBQUssQ0FBQ0Msa0JBQWtCLEVBQzlCLDBEQUNGLENBQUM7RUFDSDtFQUNBNUIsS0FBSyxHQUFHVyxTQUFTLENBQUNoQixTQUFTLEVBQUVjLHNCQUFzQixDQUFDO0VBRXBELE9BQU87SUFBRVosR0FBRyxFQUFFSCxPQUFPO0lBQUVNO0VBQU0sQ0FBQztBQUNoQyxDQUFDO0FBRUQsTUFBTXdELGlDQUFpQyxHQUFHQSxDQUFDckUsU0FBUyxFQUFFc0UsVUFBVSxFQUFFcEUsTUFBTSxLQUFLO0VBQzNFb0UsVUFBVSxHQUFHQyxZQUFZLENBQUNELFVBQVUsQ0FBQztFQUNyQyxNQUFNRSxXQUFXLEdBQUcsQ0FBQyxDQUFDO0VBQ3RCLEtBQUssTUFBTWpFLE9BQU8sSUFBSStELFVBQVUsRUFBRTtJQUNoQyxJQUFJQSxVQUFVLENBQUMvRCxPQUFPLENBQUMsSUFBSStELFVBQVUsQ0FBQy9ELE9BQU8sQ0FBQyxDQUFDSCxNQUFNLEtBQUssVUFBVSxFQUFFO01BQ3BFO0lBQ0Y7SUFDQSxNQUFNO01BQUVNLEdBQUc7TUFBRUc7SUFBTSxDQUFDLEdBQUdvRCx3Q0FBd0MsQ0FDN0QxRCxPQUFPLEVBQ1ArRCxVQUFVLENBQUMvRCxPQUFPLENBQUMsRUFDbkJMLE1BQ0YsQ0FBQztJQUNELElBQUlXLEtBQUssS0FBSzRELFNBQVMsRUFBRTtNQUN2QkQsV0FBVyxDQUFDOUQsR0FBRyxDQUFDLEdBQUdHLEtBQUs7SUFDMUI7RUFDRjs7RUFFQTtFQUNBLElBQUkyRCxXQUFXLENBQUNFLFNBQVMsRUFBRTtJQUN6QkYsV0FBVyxDQUFDRyxXQUFXLEdBQUcsSUFBSTFELElBQUksQ0FBQ3VELFdBQVcsQ0FBQ0UsU0FBUyxDQUFDRSxHQUFHLElBQUlKLFdBQVcsQ0FBQ0UsU0FBUyxDQUFDO0lBQ3RGLE9BQU9GLFdBQVcsQ0FBQ0UsU0FBUztFQUM5QjtFQUNBLElBQUlGLFdBQVcsQ0FBQ0ssU0FBUyxFQUFFO0lBQ3pCTCxXQUFXLENBQUNNLFdBQVcsR0FBRyxJQUFJN0QsSUFBSSxDQUFDdUQsV0FBVyxDQUFDSyxTQUFTLENBQUNELEdBQUcsSUFBSUosV0FBVyxDQUFDSyxTQUFTLENBQUM7SUFDdEYsT0FBT0wsV0FBVyxDQUFDSyxTQUFTO0VBQzlCO0VBRUEsT0FBT0wsV0FBVztBQUNwQixDQUFDOztBQUVEO0FBQ0EsTUFBTU8sZUFBZSxHQUFHQSxDQUFDL0UsU0FBUyxFQUFFZ0YsVUFBVSxFQUFFdkUsaUJBQWlCLEtBQUs7RUFDcEUsTUFBTXdFLFdBQVcsR0FBRyxDQUFDLENBQUM7RUFDdEIsTUFBTUMsR0FBRyxHQUFHWCxZQUFZLENBQUNTLFVBQVUsQ0FBQztFQUNwQyxJQUFJRSxHQUFHLENBQUNDLE1BQU0sSUFBSUQsR0FBRyxDQUFDRSxNQUFNLElBQUlGLEdBQUcsQ0FBQ0csSUFBSSxFQUFFO0lBQ3hDSixXQUFXLENBQUNLLElBQUksR0FBRyxDQUFDLENBQUM7SUFDckIsSUFBSUosR0FBRyxDQUFDQyxNQUFNLEVBQUU7TUFDZEYsV0FBVyxDQUFDSyxJQUFJLENBQUNILE1BQU0sR0FBR0QsR0FBRyxDQUFDQyxNQUFNO0lBQ3RDO0lBQ0EsSUFBSUQsR0FBRyxDQUFDRSxNQUFNLEVBQUU7TUFDZEgsV0FBVyxDQUFDSyxJQUFJLENBQUNGLE1BQU0sR0FBR0YsR0FBRyxDQUFDRSxNQUFNO0lBQ3RDO0lBQ0EsSUFBSUYsR0FBRyxDQUFDRyxJQUFJLEVBQUU7TUFDWkosV0FBVyxDQUFDSyxJQUFJLENBQUNELElBQUksR0FBR0gsR0FBRyxDQUFDRyxJQUFJO0lBQ2xDO0VBQ0Y7RUFDQSxLQUFLLElBQUk5RSxPQUFPLElBQUl5RSxVQUFVLEVBQUU7SUFDOUIsSUFBSUEsVUFBVSxDQUFDekUsT0FBTyxDQUFDLElBQUl5RSxVQUFVLENBQUN6RSxPQUFPLENBQUMsQ0FBQ0gsTUFBTSxLQUFLLFVBQVUsRUFBRTtNQUNwRTtJQUNGO0lBQ0EsSUFBSTRELEdBQUcsR0FBRzFELDBCQUEwQixDQUNsQ04sU0FBUyxFQUNUTyxPQUFPLEVBQ1B5RSxVQUFVLENBQUN6RSxPQUFPLENBQUMsRUFDbkJFLGlCQUNGLENBQUM7O0lBRUQ7SUFDQTtJQUNBO0lBQ0EsSUFBSSxPQUFPdUQsR0FBRyxDQUFDbkQsS0FBSyxLQUFLLFFBQVEsSUFBSW1ELEdBQUcsQ0FBQ25ELEtBQUssS0FBSyxJQUFJLElBQUltRCxHQUFHLENBQUNuRCxLQUFLLENBQUMwRSxJQUFJLEVBQUU7TUFDekVOLFdBQVcsQ0FBQ2pCLEdBQUcsQ0FBQ25ELEtBQUssQ0FBQzBFLElBQUksQ0FBQyxHQUFHTixXQUFXLENBQUNqQixHQUFHLENBQUNuRCxLQUFLLENBQUMwRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7TUFDL0ROLFdBQVcsQ0FBQ2pCLEdBQUcsQ0FBQ25ELEtBQUssQ0FBQzBFLElBQUksQ0FBQyxDQUFDdkIsR0FBRyxDQUFDdEQsR0FBRyxDQUFDLEdBQUdzRCxHQUFHLENBQUNuRCxLQUFLLENBQUMyRSxHQUFHO0lBQ3RELENBQUMsTUFBTTtNQUNMUCxXQUFXLENBQUMsTUFBTSxDQUFDLEdBQUdBLFdBQVcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7TUFDL0NBLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQ2pCLEdBQUcsQ0FBQ3RELEdBQUcsQ0FBQyxHQUFHc0QsR0FBRyxDQUFDbkQsS0FBSztJQUMxQztFQUNGO0VBRUEsT0FBT29FLFdBQVc7QUFDcEIsQ0FBQzs7QUFFRDtBQUNBLE1BQU1WLFlBQVksR0FBR2tCLFVBQVUsSUFBSTtFQUNqQyxNQUFNQyxjQUFjLEdBQUc7SUFBRSxHQUFHRDtFQUFXLENBQUM7RUFDeEMsTUFBTUosSUFBSSxHQUFHLENBQUMsQ0FBQztFQUVmLElBQUlJLFVBQVUsQ0FBQ0wsTUFBTSxFQUFFO0lBQ3JCSyxVQUFVLENBQUNMLE1BQU0sQ0FBQ08sT0FBTyxDQUFDQyxLQUFLLElBQUk7TUFDakNQLElBQUksQ0FBQ08sS0FBSyxDQUFDLEdBQUc7UUFBRUMsQ0FBQyxFQUFFO01BQUssQ0FBQztJQUMzQixDQUFDLENBQUM7SUFDRkgsY0FBYyxDQUFDTCxJQUFJLEdBQUdBLElBQUk7RUFDNUI7RUFFQSxJQUFJSSxVQUFVLENBQUNOLE1BQU0sRUFBRTtJQUNyQk0sVUFBVSxDQUFDTixNQUFNLENBQUNRLE9BQU8sQ0FBQ0MsS0FBSyxJQUFJO01BQ2pDO01BQ0EsSUFBSSxDQUFDdEQsTUFBTSxDQUFDd0QsTUFBTSxDQUFDVCxJQUFJLEVBQUVPLEtBQUssQ0FBQyxFQUFFO1FBQy9CUCxJQUFJLENBQUNPLEtBQUssQ0FBQyxHQUFHO1VBQUVHLENBQUMsRUFBRTtRQUFLLENBQUM7TUFDM0IsQ0FBQyxNQUFNO1FBQ0xWLElBQUksQ0FBQ08sS0FBSyxDQUFDLENBQUNHLENBQUMsR0FBRyxJQUFJO01BQ3RCO0lBQ0YsQ0FBQyxDQUFDO0lBQ0ZMLGNBQWMsQ0FBQ0wsSUFBSSxHQUFHQSxJQUFJO0VBQzVCO0VBRUEsT0FBT0ssY0FBYztBQUN2QixDQUFDOztBQUVEO0FBQ0E7QUFDQSxTQUFTMUUsZUFBZUEsQ0FBQSxFQUFHLENBQUM7QUFFNUIsTUFBTTBCLHFCQUFxQixHQUFHc0QsSUFBSSxJQUFJO0VBQ3BDO0VBQ0EsSUFBSSxPQUFPQSxJQUFJLEtBQUssUUFBUSxJQUFJQSxJQUFJLElBQUksQ0FBQ2xHLEtBQUssQ0FBQzZDLE1BQU0sQ0FBQ3FELElBQUksQ0FBQyxJQUFJQSxJQUFJLENBQUM1RixNQUFNLEtBQUssU0FBUyxFQUFFO0lBQ3hGLE9BQU87TUFDTEEsTUFBTSxFQUFFLFNBQVM7TUFDakJKLFNBQVMsRUFBRWdHLElBQUksQ0FBQ2hHLFNBQVM7TUFDekJpRyxRQUFRLEVBQUVELElBQUksQ0FBQ0M7SUFDakIsQ0FBQztFQUNILENBQUMsTUFBTSxJQUFJLE9BQU9ELElBQUksS0FBSyxVQUFVLElBQUksT0FBT0EsSUFBSSxLQUFLLFFBQVEsRUFBRTtJQUNqRSxNQUFNLElBQUluRyxLQUFLLENBQUMyQyxLQUFLLENBQUMzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQUUsMkJBQTJCbUMsSUFBSSxFQUFFLENBQUM7RUFDcEYsQ0FBQyxNQUFNLElBQUlFLFNBQVMsQ0FBQ0MsV0FBVyxDQUFDSCxJQUFJLENBQUMsRUFBRTtJQUN0QyxPQUFPRSxTQUFTLENBQUNFLGNBQWMsQ0FBQ0osSUFBSSxDQUFDO0VBQ3ZDLENBQUMsTUFBTSxJQUFJSyxVQUFVLENBQUNGLFdBQVcsQ0FBQ0gsSUFBSSxDQUFDLEVBQUU7SUFDdkMsT0FBT0ssVUFBVSxDQUFDRCxjQUFjLENBQUNKLElBQUksQ0FBQztFQUN4QyxDQUFDLE1BQU0sSUFBSSxPQUFPQSxJQUFJLEtBQUssUUFBUSxJQUFJQSxJQUFJLElBQUlBLElBQUksQ0FBQ00sTUFBTSxLQUFLN0IsU0FBUyxFQUFFO0lBQ3hFLE9BQU8sSUFBSThCLE1BQU0sQ0FBQ1AsSUFBSSxDQUFDTSxNQUFNLENBQUM7RUFDaEMsQ0FBQyxNQUFNO0lBQ0wsT0FBT04sSUFBSTtFQUNiO0FBQ0YsQ0FBQzs7QUFFRDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFNBQVNqRixxQkFBcUJBLENBQUNpRixJQUFJLEVBQUUxQyxLQUFLLEVBQUU7RUFDMUMsUUFBUSxPQUFPMEMsSUFBSTtJQUNqQixLQUFLLFFBQVE7SUFDYixLQUFLLFNBQVM7SUFDZCxLQUFLLFdBQVc7TUFDZCxPQUFPQSxJQUFJO0lBQ2IsS0FBSyxRQUFRO01BQ1gsSUFBSTFDLEtBQUssSUFBSUEsS0FBSyxDQUFDakQsSUFBSSxLQUFLLFNBQVMsRUFBRTtRQUNyQyxPQUFPLEdBQUdpRCxLQUFLLENBQUNrRCxXQUFXLElBQUlSLElBQUksRUFBRTtNQUN2QztNQUNBLE9BQU9BLElBQUk7SUFDYixLQUFLLFFBQVE7SUFDYixLQUFLLFVBQVU7TUFDYixNQUFNLElBQUluRyxLQUFLLENBQUMyQyxLQUFLLENBQUMzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQUUsMkJBQTJCbUMsSUFBSSxFQUFFLENBQUM7SUFDcEYsS0FBSyxRQUFRO01BQ1gsSUFBSWxHLEtBQUssQ0FBQzZDLE1BQU0sQ0FBQ3FELElBQUksQ0FBQyxFQUFFO1FBQ3RCO1FBQ0E7UUFDQSxPQUFPQSxJQUFJO01BQ2I7TUFFQSxJQUFJQSxJQUFJLEtBQUssSUFBSSxFQUFFO1FBQ2pCLE9BQU9BLElBQUk7TUFDYjs7TUFFQTtNQUNBLElBQUlBLElBQUksQ0FBQzVGLE1BQU0sSUFBSSxTQUFTLEVBQUU7UUFDNUIsT0FBTyxHQUFHNEYsSUFBSSxDQUFDaEcsU0FBUyxJQUFJZ0csSUFBSSxDQUFDQyxRQUFRLEVBQUU7TUFDN0M7TUFDQSxJQUFJQyxTQUFTLENBQUNDLFdBQVcsQ0FBQ0gsSUFBSSxDQUFDLEVBQUU7UUFDL0IsT0FBT0UsU0FBUyxDQUFDRSxjQUFjLENBQUNKLElBQUksQ0FBQztNQUN2QztNQUNBLElBQUlLLFVBQVUsQ0FBQ0YsV0FBVyxDQUFDSCxJQUFJLENBQUMsRUFBRTtRQUNoQyxPQUFPSyxVQUFVLENBQUNELGNBQWMsQ0FBQ0osSUFBSSxDQUFDO01BQ3hDO01BQ0EsSUFBSVMsYUFBYSxDQUFDTixXQUFXLENBQUNILElBQUksQ0FBQyxFQUFFO1FBQ25DLE9BQU9TLGFBQWEsQ0FBQ0wsY0FBYyxDQUFDSixJQUFJLENBQUM7TUFDM0M7TUFDQSxJQUFJVSxZQUFZLENBQUNQLFdBQVcsQ0FBQ0gsSUFBSSxDQUFDLEVBQUU7UUFDbEMsT0FBT1UsWUFBWSxDQUFDTixjQUFjLENBQUNKLElBQUksQ0FBQztNQUMxQztNQUNBLElBQUlXLFNBQVMsQ0FBQ1IsV0FBVyxDQUFDSCxJQUFJLENBQUMsRUFBRTtRQUMvQixPQUFPVyxTQUFTLENBQUNQLGNBQWMsQ0FBQ0osSUFBSSxDQUFDO01BQ3ZDO01BQ0EsT0FBT2hGLGVBQWU7SUFFeEI7TUFDRTtNQUNBLE1BQU0sSUFBSW5CLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNvRSxxQkFBcUIsRUFDakMsZ0NBQWdDWixJQUFJLEVBQ3RDLENBQUM7RUFDTDtBQUNGOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxTQUFTeEMsbUJBQW1CQSxDQUFDcUQsVUFBVSxFQUFFdkQsS0FBSyxFQUFFd0QsUUFBUSxFQUFFaEUsS0FBSyxHQUFHLEtBQUssRUFBRTtFQUN2RSxNQUFNaUUsT0FBTyxHQUFHekQsS0FBSyxJQUFJQSxLQUFLLENBQUNqRCxJQUFJLElBQUlpRCxLQUFLLENBQUNqRCxJQUFJLEtBQUssT0FBTztFQUM3RDtFQUNBLE1BQU0yRyxXQUFXLEdBQUdGLFFBQVEsQ0FBQzVGLE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7RUFDOUMsSUFBSSxPQUFPMkYsVUFBVSxLQUFLLFFBQVEsSUFBSSxDQUFDQSxVQUFVLEVBQUU7SUFDakQsT0FBTzdGLGVBQWU7RUFDeEI7RUFDQTtFQUNBLE1BQU1pRyxpQkFBaUIsR0FBSUYsT0FBTyxJQUFJQyxXQUFXLEdBQUl0RSxxQkFBcUIsR0FBRzNCLHFCQUFxQjtFQUNsRyxNQUFNbUcsV0FBVyxHQUFHbEIsSUFBSSxJQUFJO0lBQzFCLE1BQU1tQixNQUFNLEdBQUdGLGlCQUFpQixDQUFDakIsSUFBSSxFQUFFMUMsS0FBSyxDQUFDO0lBQzdDLElBQUk2RCxNQUFNLEtBQUtuRyxlQUFlLEVBQUU7TUFDOUIsTUFBTSxJQUFJbkIsS0FBSyxDQUFDMkMsS0FBSyxDQUFDM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUFFLGFBQWF1RCxJQUFJLENBQUNDLFNBQVMsQ0FBQ3JCLElBQUksQ0FBQyxFQUFFLENBQUM7SUFDdEY7SUFDQSxPQUFPbUIsTUFBTTtFQUNmLENBQUM7RUFDRDtFQUNBO0VBQ0E7RUFDQTtFQUNBLElBQUk1RSxJQUFJLEdBQUdELE1BQU0sQ0FBQ0MsSUFBSSxDQUFDc0UsVUFBVSxDQUFDLENBQUNTLElBQUksQ0FBQyxDQUFDLENBQUNDLE9BQU8sQ0FBQyxDQUFDO0VBQ25ELElBQUlDLE1BQU0sR0FBRyxDQUFDLENBQUM7RUFDZixLQUFLLElBQUk5RyxHQUFHLElBQUk2QixJQUFJLEVBQUU7SUFDcEIsUUFBUTdCLEdBQUc7TUFDVCxLQUFLLEtBQUs7TUFDVixLQUFLLE1BQU07TUFDWCxLQUFLLEtBQUs7TUFDVixLQUFLLE1BQU07TUFDWCxLQUFLLFNBQVM7TUFDZCxLQUFLLEtBQUs7TUFDVixLQUFLLEtBQUs7UUFBRTtVQUNWLE1BQU0rRyxHQUFHLEdBQUdaLFVBQVUsQ0FBQ25HLEdBQUcsQ0FBQztVQUMzQixJQUFJK0csR0FBRyxJQUFJLE9BQU9BLEdBQUcsS0FBSyxRQUFRLElBQUlBLEdBQUcsQ0FBQ0MsYUFBYSxFQUFFO1lBQ3ZELElBQUlwRSxLQUFLLElBQUlBLEtBQUssQ0FBQ2pELElBQUksS0FBSyxNQUFNLEVBQUU7Y0FDbEMsTUFBTSxJQUFJUixLQUFLLENBQUMyQyxLQUFLLENBQ25CM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUN4QixnREFDRixDQUFDO1lBQ0g7WUFFQSxRQUFRbkQsR0FBRztjQUNULEtBQUssU0FBUztjQUNkLEtBQUssS0FBSztjQUNWLEtBQUssS0FBSztnQkFDUixNQUFNLElBQUliLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQ3hCLDRFQUNGLENBQUM7WUFDTDtZQUVBLE1BQU04RCxZQUFZLEdBQUc3SCxLQUFLLENBQUM4SCxrQkFBa0IsQ0FBQ0gsR0FBRyxDQUFDQyxhQUFhLENBQUM7WUFDaEUsSUFBSUMsWUFBWSxDQUFDRSxNQUFNLEtBQUssU0FBUyxFQUFFO2NBQ3JDTCxNQUFNLENBQUM5RyxHQUFHLENBQUMsR0FBR2lILFlBQVksQ0FBQ1IsTUFBTTtjQUNqQztZQUNGO1lBRUFXLGVBQUcsQ0FBQ0MsSUFBSSxDQUFDLG1DQUFtQyxFQUFFSixZQUFZLENBQUM7WUFDM0QsTUFBTSxJQUFJOUgsS0FBSyxDQUFDMkMsS0FBSyxDQUNuQjNDLEtBQUssQ0FBQzJDLEtBQUssQ0FBQ3FCLFlBQVksRUFDeEIsc0JBQXNCbkQsR0FBRyxZQUFZaUgsWUFBWSxDQUFDSSxJQUFJLEVBQ3hELENBQUM7VUFDSDtVQUVBUCxNQUFNLENBQUM5RyxHQUFHLENBQUMsR0FBR3dHLFdBQVcsQ0FBQ08sR0FBRyxDQUFDO1VBQzlCO1FBQ0Y7TUFFQSxLQUFLLEtBQUs7TUFDVixLQUFLLE1BQU07UUFBRTtVQUNYLE1BQU1PLEdBQUcsR0FBR25CLFVBQVUsQ0FBQ25HLEdBQUcsQ0FBQztVQUMzQixJQUFJLENBQUNTLEtBQUssQ0FBQ0MsT0FBTyxDQUFDNEcsR0FBRyxDQUFDLEVBQUU7WUFDdkIsTUFBTSxJQUFJbkksS0FBSyxDQUFDMkMsS0FBSyxDQUFDM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUFFLE1BQU0sR0FBR25ELEdBQUcsR0FBRyxRQUFRLENBQUM7VUFDMUU7VUFDQThHLE1BQU0sQ0FBQzlHLEdBQUcsQ0FBQyxHQUFHdUgsZUFBQyxDQUFDQyxPQUFPLENBQUNGLEdBQUcsRUFBRW5ILEtBQUssSUFBSTtZQUNwQyxPQUFPLENBQUNtRixJQUFJLElBQUk7Y0FDZCxJQUFJN0UsS0FBSyxDQUFDQyxPQUFPLENBQUM0RSxJQUFJLENBQUMsRUFBRTtnQkFDdkIsT0FBT25GLEtBQUssQ0FBQ1EsR0FBRyxDQUFDNkYsV0FBVyxDQUFDO2NBQy9CLENBQUMsTUFBTTtnQkFDTCxPQUFPQSxXQUFXLENBQUNsQixJQUFJLENBQUM7Y0FDMUI7WUFDRixDQUFDLEVBQUVuRixLQUFLLENBQUM7VUFDWCxDQUFDLENBQUM7VUFDRjtRQUNGO01BQ0EsS0FBSyxNQUFNO1FBQUU7VUFDWCxNQUFNbUgsR0FBRyxHQUFHbkIsVUFBVSxDQUFDbkcsR0FBRyxDQUFDO1VBQzNCLElBQUksQ0FBQ1MsS0FBSyxDQUFDQyxPQUFPLENBQUM0RyxHQUFHLENBQUMsRUFBRTtZQUN2QixNQUFNLElBQUluSSxLQUFLLENBQUMyQyxLQUFLLENBQUMzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQUUsTUFBTSxHQUFHbkQsR0FBRyxHQUFHLFFBQVEsQ0FBQztVQUMxRTtVQUNBOEcsTUFBTSxDQUFDOUcsR0FBRyxDQUFDLEdBQUdzSCxHQUFHLENBQUMzRyxHQUFHLENBQUNxQixxQkFBcUIsQ0FBQztVQUU1QyxNQUFNVixNQUFNLEdBQUd3RixNQUFNLENBQUM5RyxHQUFHLENBQUM7VUFDMUIsSUFBSTBCLGVBQWUsQ0FBQ0osTUFBTSxDQUFDLElBQUksQ0FBQ0Qsc0JBQXNCLENBQUNDLE1BQU0sQ0FBQyxFQUFFO1lBQzlELE1BQU0sSUFBSW5DLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQ3hCLGlEQUFpRCxHQUFHN0IsTUFDdEQsQ0FBQztVQUNIO1VBRUE7UUFDRjtNQUNBLEtBQUssUUFBUTtRQUNYLElBQUltRyxDQUFDLEdBQUd0QixVQUFVLENBQUNuRyxHQUFHLENBQUM7UUFDdkIsSUFBSSxPQUFPeUgsQ0FBQyxLQUFLLFFBQVEsRUFBRTtVQUN6QixNQUFNLElBQUl0SSxLQUFLLENBQUMyQyxLQUFLLENBQUMzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQUUsYUFBYSxHQUFHc0UsQ0FBQyxDQUFDO1FBQ3BFO1FBQ0FYLE1BQU0sQ0FBQzlHLEdBQUcsQ0FBQyxHQUFHeUgsQ0FBQztRQUNmO01BRUYsS0FBSyxjQUFjO1FBQUU7VUFDbkIsTUFBTUgsR0FBRyxHQUFHbkIsVUFBVSxDQUFDbkcsR0FBRyxDQUFDO1VBQzNCLElBQUksQ0FBQ1MsS0FBSyxDQUFDQyxPQUFPLENBQUM0RyxHQUFHLENBQUMsRUFBRTtZQUN2QixNQUFNLElBQUluSSxLQUFLLENBQUMyQyxLQUFLLENBQUMzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQUUsc0NBQXNDLENBQUM7VUFDekY7VUFDQTJELE1BQU0sQ0FBQzlELFVBQVUsR0FBRztZQUNsQjBFLElBQUksRUFBRUosR0FBRyxDQUFDM0csR0FBRyxDQUFDNkYsV0FBVztVQUMzQixDQUFDO1VBQ0Q7UUFDRjtNQUNBLEtBQUssVUFBVTtRQUNiTSxNQUFNLENBQUM5RyxHQUFHLENBQUMsR0FBR21HLFVBQVUsQ0FBQ25HLEdBQUcsQ0FBQztRQUM3QjtNQUVGLEtBQUssT0FBTztRQUFFO1VBQ1osTUFBTTJILE1BQU0sR0FBR3hCLFVBQVUsQ0FBQ25HLEdBQUcsQ0FBQyxDQUFDNEgsT0FBTztVQUN0QyxJQUFJLE9BQU9ELE1BQU0sS0FBSyxRQUFRLEVBQUU7WUFDOUIsTUFBTSxJQUFJeEksS0FBSyxDQUFDMkMsS0FBSyxDQUFDM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUFFLHNDQUFzQyxDQUFDO1VBQ3pGO1VBQ0EsSUFBSSxDQUFDd0UsTUFBTSxDQUFDRSxLQUFLLElBQUksT0FBT0YsTUFBTSxDQUFDRSxLQUFLLEtBQUssUUFBUSxFQUFFO1lBQ3JELE1BQU0sSUFBSTFJLEtBQUssQ0FBQzJDLEtBQUssQ0FBQzNDLEtBQUssQ0FBQzJDLEtBQUssQ0FBQ3FCLFlBQVksRUFBRSxvQ0FBb0MsQ0FBQztVQUN2RixDQUFDLE1BQU07WUFDTDJELE1BQU0sQ0FBQzlHLEdBQUcsQ0FBQyxHQUFHO2NBQ1o0SCxPQUFPLEVBQUVELE1BQU0sQ0FBQ0U7WUFDbEIsQ0FBQztVQUNIO1VBQ0EsSUFBSUYsTUFBTSxDQUFDRyxTQUFTLElBQUksT0FBT0gsTUFBTSxDQUFDRyxTQUFTLEtBQUssUUFBUSxFQUFFO1lBQzVELE1BQU0sSUFBSTNJLEtBQUssQ0FBQzJDLEtBQUssQ0FBQzNDLEtBQUssQ0FBQzJDLEtBQUssQ0FBQ3FCLFlBQVksRUFBRSx3Q0FBd0MsQ0FBQztVQUMzRixDQUFDLE1BQU0sSUFBSXdFLE1BQU0sQ0FBQ0csU0FBUyxFQUFFO1lBQzNCaEIsTUFBTSxDQUFDOUcsR0FBRyxDQUFDLENBQUM4SCxTQUFTLEdBQUdILE1BQU0sQ0FBQ0csU0FBUztVQUMxQztVQUNBLElBQUlILE1BQU0sQ0FBQ0ksY0FBYyxJQUFJLE9BQU9KLE1BQU0sQ0FBQ0ksY0FBYyxLQUFLLFNBQVMsRUFBRTtZQUN2RSxNQUFNLElBQUk1SSxLQUFLLENBQUMyQyxLQUFLLENBQ25CM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUN4Qiw4Q0FDRixDQUFDO1VBQ0gsQ0FBQyxNQUFNLElBQUl3RSxNQUFNLENBQUNJLGNBQWMsRUFBRTtZQUNoQ2pCLE1BQU0sQ0FBQzlHLEdBQUcsQ0FBQyxDQUFDK0gsY0FBYyxHQUFHSixNQUFNLENBQUNJLGNBQWM7VUFDcEQ7VUFDQSxJQUFJSixNQUFNLENBQUNLLG1CQUFtQixJQUFJLE9BQU9MLE1BQU0sQ0FBQ0ssbUJBQW1CLEtBQUssU0FBUyxFQUFFO1lBQ2pGLE1BQU0sSUFBSTdJLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQ3hCLG1EQUNGLENBQUM7VUFDSCxDQUFDLE1BQU0sSUFBSXdFLE1BQU0sQ0FBQ0ssbUJBQW1CLEVBQUU7WUFDckNsQixNQUFNLENBQUM5RyxHQUFHLENBQUMsQ0FBQ2dJLG1CQUFtQixHQUFHTCxNQUFNLENBQUNLLG1CQUFtQjtVQUM5RDtVQUNBO1FBQ0Y7TUFDQSxLQUFLLGFBQWE7UUFBRTtVQUNsQixNQUFNQyxLQUFLLEdBQUc5QixVQUFVLENBQUNuRyxHQUFHLENBQUM7VUFDN0IsSUFBSW9DLEtBQUssRUFBRTtZQUNUMEUsTUFBTSxDQUFDb0IsVUFBVSxHQUFHO2NBQ2xCQyxhQUFhLEVBQUUsQ0FBQyxDQUFDRixLQUFLLENBQUNHLFNBQVMsRUFBRUgsS0FBSyxDQUFDSSxRQUFRLENBQUMsRUFBRWxDLFVBQVUsQ0FBQ21DLFlBQVk7WUFDNUUsQ0FBQztVQUNILENBQUMsTUFBTTtZQUNMeEIsTUFBTSxDQUFDOUcsR0FBRyxDQUFDLEdBQUcsQ0FBQ2lJLEtBQUssQ0FBQ0csU0FBUyxFQUFFSCxLQUFLLENBQUNJLFFBQVEsQ0FBQztVQUNqRDtVQUNBO1FBQ0Y7TUFDQSxLQUFLLGNBQWM7UUFBRTtVQUNuQixJQUFJakcsS0FBSyxFQUFFO1lBQ1Q7VUFDRjtVQUNBMEUsTUFBTSxDQUFDOUcsR0FBRyxDQUFDLEdBQUdtRyxVQUFVLENBQUNuRyxHQUFHLENBQUM7VUFDN0I7UUFDRjtNQUNBO01BQ0E7TUFDQSxLQUFLLHVCQUF1QjtRQUMxQjhHLE1BQU0sQ0FBQyxjQUFjLENBQUMsR0FBR1gsVUFBVSxDQUFDbkcsR0FBRyxDQUFDO1FBQ3hDO01BQ0YsS0FBSyxxQkFBcUI7UUFDeEI4RyxNQUFNLENBQUMsY0FBYyxDQUFDLEdBQUdYLFVBQVUsQ0FBQ25HLEdBQUcsQ0FBQyxHQUFHLElBQUk7UUFDL0M7TUFDRixLQUFLLDBCQUEwQjtRQUM3QjhHLE1BQU0sQ0FBQyxjQUFjLENBQUMsR0FBR1gsVUFBVSxDQUFDbkcsR0FBRyxDQUFDLEdBQUcsSUFBSTtRQUMvQztNQUVGLEtBQUssU0FBUztNQUNkLEtBQUssYUFBYTtRQUNoQixNQUFNLElBQUliLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUN5RyxtQkFBbUIsRUFDL0IsTUFBTSxHQUFHdkksR0FBRyxHQUFHLGtDQUNqQixDQUFDO01BRUgsS0FBSyxTQUFTO1FBQ1osSUFBSXdJLEdBQUcsR0FBR3JDLFVBQVUsQ0FBQ25HLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQztRQUNqQyxJQUFJLENBQUN3SSxHQUFHLElBQUlBLEdBQUcsQ0FBQ2pILE1BQU0sSUFBSSxDQUFDLEVBQUU7VUFDM0IsTUFBTSxJQUFJcEMsS0FBSyxDQUFDMkMsS0FBSyxDQUFDM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUFFLDBCQUEwQixDQUFDO1FBQzdFO1FBQ0EyRCxNQUFNLENBQUM5RyxHQUFHLENBQUMsR0FBRztVQUNaeUksSUFBSSxFQUFFLENBQ0osQ0FBQ0QsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDSixTQUFTLEVBQUVJLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQ0gsUUFBUSxDQUFDLEVBQ25DLENBQUNHLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQ0osU0FBUyxFQUFFSSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUNILFFBQVEsQ0FBQztRQUV2QyxDQUFDO1FBQ0Q7TUFFRixLQUFLLFlBQVk7UUFBRTtVQUNqQixNQUFNSyxPQUFPLEdBQUd2QyxVQUFVLENBQUNuRyxHQUFHLENBQUMsQ0FBQyxVQUFVLENBQUM7VUFDM0MsTUFBTTJJLFlBQVksR0FBR3hDLFVBQVUsQ0FBQ25HLEdBQUcsQ0FBQyxDQUFDLGVBQWUsQ0FBQztVQUNyRCxJQUFJMEksT0FBTyxLQUFLM0UsU0FBUyxFQUFFO1lBQ3pCLElBQUk2RSxNQUFNO1lBQ1YsSUFBSSxPQUFPRixPQUFPLEtBQUssUUFBUSxJQUFJQSxPQUFPLENBQUNoSixNQUFNLEtBQUssU0FBUyxFQUFFO2NBQy9ELElBQUksQ0FBQ2dKLE9BQU8sQ0FBQ0csV0FBVyxJQUFJSCxPQUFPLENBQUNHLFdBQVcsQ0FBQ3RILE1BQU0sR0FBRyxDQUFDLEVBQUU7Z0JBQzFELE1BQU0sSUFBSXBDLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQ3hCLG1GQUNGLENBQUM7Y0FDSDtjQUNBeUYsTUFBTSxHQUFHRixPQUFPLENBQUNHLFdBQVc7WUFDOUIsQ0FBQyxNQUFNLElBQUlwSSxLQUFLLENBQUNDLE9BQU8sQ0FBQ2dJLE9BQU8sQ0FBQyxFQUFFO2NBQ2pDLElBQUlBLE9BQU8sQ0FBQ25ILE1BQU0sR0FBRyxDQUFDLEVBQUU7Z0JBQ3RCLE1BQU0sSUFBSXBDLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQ3hCLG9FQUNGLENBQUM7Y0FDSDtjQUNBeUYsTUFBTSxHQUFHRixPQUFPO1lBQ2xCLENBQUMsTUFBTTtjQUNMLE1BQU0sSUFBSXZKLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQ3hCLHNGQUNGLENBQUM7WUFDSDtZQUNBeUYsTUFBTSxHQUFHQSxNQUFNLENBQUNqSSxHQUFHLENBQUNzSCxLQUFLLElBQUk7Y0FDM0IsSUFBSXhILEtBQUssQ0FBQ0MsT0FBTyxDQUFDdUgsS0FBSyxDQUFDLElBQUlBLEtBQUssQ0FBQzFHLE1BQU0sS0FBSyxDQUFDLEVBQUU7Z0JBQzlDcEMsS0FBSyxDQUFDMkosUUFBUSxDQUFDQyxTQUFTLENBQUNkLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRUEsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUM1QyxPQUFPQSxLQUFLO2NBQ2Q7Y0FDQSxJQUFJLENBQUNsQyxhQUFhLENBQUNOLFdBQVcsQ0FBQ3dDLEtBQUssQ0FBQyxFQUFFO2dCQUNyQyxNQUFNLElBQUk5SSxLQUFLLENBQUMyQyxLQUFLLENBQUMzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQUUsc0JBQXNCLENBQUM7Y0FDekUsQ0FBQyxNQUFNO2dCQUNMaEUsS0FBSyxDQUFDMkosUUFBUSxDQUFDQyxTQUFTLENBQUNkLEtBQUssQ0FBQ0ksUUFBUSxFQUFFSixLQUFLLENBQUNHLFNBQVMsQ0FBQztjQUMzRDtjQUNBLE9BQU8sQ0FBQ0gsS0FBSyxDQUFDRyxTQUFTLEVBQUVILEtBQUssQ0FBQ0ksUUFBUSxDQUFDO1lBQzFDLENBQUMsQ0FBQztZQUNGdkIsTUFBTSxDQUFDOUcsR0FBRyxDQUFDLEdBQUc7Y0FDWmdKLFFBQVEsRUFBRUo7WUFDWixDQUFDO1VBQ0gsQ0FBQyxNQUFNLElBQUlELFlBQVksS0FBSzVFLFNBQVMsRUFBRTtZQUNyQyxJQUFJLENBQUN0RCxLQUFLLENBQUNDLE9BQU8sQ0FBQ2lJLFlBQVksQ0FBQyxJQUFJQSxZQUFZLENBQUNwSCxNQUFNLEdBQUcsQ0FBQyxFQUFFO2NBQzNELE1BQU0sSUFBSXBDLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNxQixZQUFZLEVBQ3hCLHVGQUNGLENBQUM7WUFDSDtZQUNBO1lBQ0EsSUFBSThFLEtBQUssR0FBR1UsWUFBWSxDQUFDLENBQUMsQ0FBQztZQUMzQixJQUFJbEksS0FBSyxDQUFDQyxPQUFPLENBQUN1SCxLQUFLLENBQUMsSUFBSUEsS0FBSyxDQUFDMUcsTUFBTSxLQUFLLENBQUMsRUFBRTtjQUM5QzBHLEtBQUssR0FBRyxJQUFJOUksS0FBSyxDQUFDMkosUUFBUSxDQUFDYixLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUVBLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNoRCxDQUFDLE1BQU0sSUFBSSxDQUFDbEMsYUFBYSxDQUFDTixXQUFXLENBQUN3QyxLQUFLLENBQUMsRUFBRTtjQUM1QyxNQUFNLElBQUk5SSxLQUFLLENBQUMyQyxLQUFLLENBQ25CM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUN4Qix1REFDRixDQUFDO1lBQ0g7WUFDQWhFLEtBQUssQ0FBQzJKLFFBQVEsQ0FBQ0MsU0FBUyxDQUFDZCxLQUFLLENBQUNJLFFBQVEsRUFBRUosS0FBSyxDQUFDRyxTQUFTLENBQUM7WUFDekQ7WUFDQSxNQUFNYSxRQUFRLEdBQUdOLFlBQVksQ0FBQyxDQUFDLENBQUM7WUFDaEMsSUFBSU8sS0FBSyxDQUFDRCxRQUFRLENBQUMsSUFBSUEsUUFBUSxHQUFHLENBQUMsRUFBRTtjQUNuQyxNQUFNLElBQUk5SixLQUFLLENBQUMyQyxLQUFLLENBQ25CM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUN4QixzREFDRixDQUFDO1lBQ0g7WUFDQTJELE1BQU0sQ0FBQzlHLEdBQUcsQ0FBQyxHQUFHO2NBQ1ptSSxhQUFhLEVBQUUsQ0FBQyxDQUFDRixLQUFLLENBQUNHLFNBQVMsRUFBRUgsS0FBSyxDQUFDSSxRQUFRLENBQUMsRUFBRVksUUFBUTtZQUM3RCxDQUFDO1VBQ0g7VUFDQTtRQUNGO01BQ0EsS0FBSyxnQkFBZ0I7UUFBRTtVQUNyQixNQUFNaEIsS0FBSyxHQUFHOUIsVUFBVSxDQUFDbkcsR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDO1VBQ3ZDLElBQUksQ0FBQytGLGFBQWEsQ0FBQ04sV0FBVyxDQUFDd0MsS0FBSyxDQUFDLEVBQUU7WUFDckMsTUFBTSxJQUFJOUksS0FBSyxDQUFDMkMsS0FBSyxDQUNuQjNDLEtBQUssQ0FBQzJDLEtBQUssQ0FBQ3FCLFlBQVksRUFDeEIsb0RBQ0YsQ0FBQztVQUNILENBQUMsTUFBTTtZQUNMaEUsS0FBSyxDQUFDMkosUUFBUSxDQUFDQyxTQUFTLENBQUNkLEtBQUssQ0FBQ0ksUUFBUSxFQUFFSixLQUFLLENBQUNHLFNBQVMsQ0FBQztVQUMzRDtVQUNBdEIsTUFBTSxDQUFDOUcsR0FBRyxDQUFDLEdBQUc7WUFDWm1KLFNBQVMsRUFBRTtjQUNUeEosSUFBSSxFQUFFLE9BQU87Y0FDYmtKLFdBQVcsRUFBRSxDQUFDWixLQUFLLENBQUNHLFNBQVMsRUFBRUgsS0FBSyxDQUFDSSxRQUFRO1lBQy9DO1VBQ0YsQ0FBQztVQUNEO1FBQ0Y7TUFDQTtRQUNFLElBQUlySSxHQUFHLENBQUNvQixLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUU7VUFDckIsTUFBTSxJQUFJakMsS0FBSyxDQUFDMkMsS0FBSyxDQUFDM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUFFLGtCQUFrQixHQUFHbkQsR0FBRyxDQUFDO1FBQzNFO1FBQ0EsT0FBT00sZUFBZTtJQUMxQjtFQUNGO0VBQ0EsT0FBT3dHLE1BQU07QUFDZjs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUEsU0FBU2pHLHVCQUF1QkEsQ0FBQztFQUFFZ0UsSUFBSTtFQUFFdUUsTUFBTTtFQUFFQztBQUFRLENBQUMsRUFBRUMsT0FBTyxFQUFFO0VBQ25FLFFBQVF6RSxJQUFJO0lBQ1YsS0FBSyxRQUFRO01BQ1gsSUFBSXlFLE9BQU8sRUFBRTtRQUNYLE9BQU92RixTQUFTO01BQ2xCLENBQUMsTUFBTTtRQUNMLE9BQU87VUFBRWMsSUFBSSxFQUFFLFFBQVE7VUFBRUMsR0FBRyxFQUFFO1FBQUcsQ0FBQztNQUNwQztJQUVGLEtBQUssV0FBVztNQUNkLElBQUksT0FBT3NFLE1BQU0sS0FBSyxRQUFRLEVBQUU7UUFDOUIsTUFBTSxJQUFJakssS0FBSyxDQUFDMkMsS0FBSyxDQUFDM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUFFLG9DQUFvQyxDQUFDO01BQ3ZGO01BQ0EsSUFBSW1HLE9BQU8sRUFBRTtRQUNYLE9BQU9GLE1BQU07TUFDZixDQUFDLE1BQU07UUFDTCxPQUFPO1VBQUV2RSxJQUFJLEVBQUUsTUFBTTtVQUFFQyxHQUFHLEVBQUVzRTtRQUFPLENBQUM7TUFDdEM7SUFFRixLQUFLLGFBQWE7TUFDaEIsSUFBSUUsT0FBTyxFQUFFO1FBQ1gsT0FBT0YsTUFBTTtNQUNmLENBQUMsTUFBTTtRQUNMLE9BQU87VUFBRXZFLElBQUksRUFBRSxjQUFjO1VBQUVDLEdBQUcsRUFBRXNFO1FBQU8sQ0FBQztNQUM5QztJQUVGLEtBQUssS0FBSztJQUNWLEtBQUssV0FBVztNQUNkLElBQUksQ0FBQzNJLEtBQUssQ0FBQ0MsT0FBTyxDQUFDMkksT0FBTyxDQUFDLEVBQUU7UUFDM0IsTUFBTSxJQUFJbEssS0FBSyxDQUFDMkMsS0FBSyxDQUFDM0MsS0FBSyxDQUFDMkMsS0FBSyxDQUFDcUIsWUFBWSxFQUFFLGlDQUFpQyxDQUFDO01BQ3BGO01BQ0EsSUFBSW9HLEtBQUssR0FBR0YsT0FBTyxDQUFDMUksR0FBRyxDQUFDcUIscUJBQXFCLENBQUM7TUFDOUMsSUFBSXNILE9BQU8sRUFBRTtRQUNYLE9BQU9DLEtBQUs7TUFDZCxDQUFDLE1BQU07UUFDTCxJQUFJQyxPQUFPLEdBQUc7VUFDWkMsR0FBRyxFQUFFLE9BQU87VUFDWkMsU0FBUyxFQUFFO1FBQ2IsQ0FBQyxDQUFDN0UsSUFBSSxDQUFDO1FBQ1AsT0FBTztVQUFFQSxJQUFJLEVBQUUyRSxPQUFPO1VBQUUxRSxHQUFHLEVBQUU7WUFBRTZFLEtBQUssRUFBRUo7VUFBTTtRQUFFLENBQUM7TUFDakQ7SUFFRixLQUFLLFFBQVE7TUFDWCxJQUFJLENBQUM5SSxLQUFLLENBQUNDLE9BQU8sQ0FBQzJJLE9BQU8sQ0FBQyxFQUFFO1FBQzNCLE1BQU0sSUFBSWxLLEtBQUssQ0FBQzJDLEtBQUssQ0FBQzNDLEtBQUssQ0FBQzJDLEtBQUssQ0FBQ3FCLFlBQVksRUFBRSxvQ0FBb0MsQ0FBQztNQUN2RjtNQUNBLElBQUl5RyxRQUFRLEdBQUdQLE9BQU8sQ0FBQzFJLEdBQUcsQ0FBQ3FCLHFCQUFxQixDQUFDO01BQ2pELElBQUlzSCxPQUFPLEVBQUU7UUFDWCxPQUFPLEVBQUU7TUFDWCxDQUFDLE1BQU07UUFDTCxPQUFPO1VBQUV6RSxJQUFJLEVBQUUsVUFBVTtVQUFFQyxHQUFHLEVBQUU4RTtRQUFTLENBQUM7TUFDNUM7SUFFRjtNQUNFLE1BQU0sSUFBSXpLLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUN5RyxtQkFBbUIsRUFDL0IsT0FBTzFELElBQUksaUNBQ2IsQ0FBQztFQUNMO0FBQ0Y7QUFDQSxTQUFTL0QsU0FBU0EsQ0FBQytJLE1BQU0sRUFBRUMsUUFBUSxFQUFFO0VBQ25DLE1BQU1yRCxNQUFNLEdBQUcsQ0FBQyxDQUFDO0VBQ2pCN0UsTUFBTSxDQUFDQyxJQUFJLENBQUNnSSxNQUFNLENBQUMsQ0FBQzVFLE9BQU8sQ0FBQ2pGLEdBQUcsSUFBSTtJQUNqQ3lHLE1BQU0sQ0FBQ3pHLEdBQUcsQ0FBQyxHQUFHOEosUUFBUSxDQUFDRCxNQUFNLENBQUM3SixHQUFHLENBQUMsQ0FBQztFQUNyQyxDQUFDLENBQUM7RUFDRixPQUFPeUcsTUFBTTtBQUNmO0FBRUEsTUFBTXNELG9DQUFvQyxHQUFHQyxXQUFXLElBQUk7RUFDMUQsUUFBUSxPQUFPQSxXQUFXO0lBQ3hCLEtBQUssUUFBUTtJQUNiLEtBQUssUUFBUTtJQUNiLEtBQUssU0FBUztJQUNkLEtBQUssV0FBVztNQUNkLE9BQU9BLFdBQVc7SUFDcEIsS0FBSyxRQUFRO0lBQ2IsS0FBSyxVQUFVO01BQ2IsTUFBTSxtREFBbUQ7SUFDM0QsS0FBSyxRQUFRO01BQ1gsSUFBSUEsV0FBVyxLQUFLLElBQUksRUFBRTtRQUN4QixPQUFPLElBQUk7TUFDYjtNQUNBLElBQUl2SixLQUFLLENBQUNDLE9BQU8sQ0FBQ3NKLFdBQVcsQ0FBQyxFQUFFO1FBQzlCLE9BQU9BLFdBQVcsQ0FBQ3JKLEdBQUcsQ0FBQ29KLG9DQUFvQyxDQUFDO01BQzlEO01BRUEsSUFBSTNLLEtBQUssQ0FBQzZDLE1BQU0sQ0FBQytILFdBQVcsQ0FBQyxFQUFFO1FBQzdCLE9BQU83SyxLQUFLLENBQUM4SyxPQUFPLENBQUNELFdBQVcsQ0FBQztNQUNuQztNQUVBLElBQUlBLFdBQVcsWUFBWTlLLE9BQU8sQ0FBQ2dMLElBQUksRUFBRTtRQUN2QyxPQUFPRixXQUFXLENBQUNHLFFBQVEsQ0FBQyxDQUFDO01BQy9CO01BRUEsSUFBSUgsV0FBVyxZQUFZOUssT0FBTyxDQUFDa0wsTUFBTSxFQUFFO1FBQ3pDLE9BQU9KLFdBQVcsQ0FBQzdKLEtBQUs7TUFDMUI7TUFFQSxJQUFJd0YsVUFBVSxDQUFDMEUscUJBQXFCLENBQUNMLFdBQVcsQ0FBQyxFQUFFO1FBQ2pELE9BQU9yRSxVQUFVLENBQUMyRSxjQUFjLENBQUNOLFdBQVcsQ0FBQztNQUMvQztNQUVBLElBQ0VwSSxNQUFNLENBQUMySSxTQUFTLENBQUNDLGNBQWMsQ0FBQ0MsSUFBSSxDQUFDVCxXQUFXLEVBQUUsUUFBUSxDQUFDLElBQzNEQSxXQUFXLENBQUN0SyxNQUFNLElBQUksTUFBTSxJQUM1Qk4sS0FBSyxDQUFDNkMsTUFBTSxDQUFDK0gsV0FBVyxDQUFDOUYsR0FBRyxDQUFDLEVBQzdCO1FBQ0E4RixXQUFXLENBQUM5RixHQUFHLEdBQUc4RixXQUFXLENBQUM5RixHQUFHLENBQUN3RyxNQUFNLENBQUMsQ0FBQztRQUMxQyxPQUFPVixXQUFXO01BQ3BCO01BRUEsT0FBT2xKLFNBQVMsQ0FBQ2tKLFdBQVcsRUFBRUQsb0NBQW9DLENBQUM7SUFDckU7TUFDRSxNQUFNLGlCQUFpQjtFQUMzQjtBQUNGLENBQUM7QUFFRCxNQUFNWSxzQkFBc0IsR0FBR0EsQ0FBQ25MLE1BQU0sRUFBRW9ELEtBQUssRUFBRWdJLGFBQWEsS0FBSztFQUMvRCxNQUFNQyxPQUFPLEdBQUdELGFBQWEsQ0FBQ0UsS0FBSyxDQUFDLEdBQUcsQ0FBQztFQUN4QyxJQUFJRCxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUtyTCxNQUFNLENBQUNDLE1BQU0sQ0FBQ21ELEtBQUssQ0FBQyxDQUFDa0QsV0FBVyxFQUFFO0lBQ25ELE1BQU0sZ0NBQWdDO0VBQ3hDO0VBQ0EsT0FBTztJQUNMcEcsTUFBTSxFQUFFLFNBQVM7SUFDakJKLFNBQVMsRUFBRXVMLE9BQU8sQ0FBQyxDQUFDLENBQUM7SUFDckJ0RixRQUFRLEVBQUVzRixPQUFPLENBQUMsQ0FBQztFQUNyQixDQUFDO0FBQ0gsQ0FBQzs7QUFFRDtBQUNBO0FBQ0EsTUFBTUUsd0JBQXdCLEdBQUdBLENBQUN6TCxTQUFTLEVBQUUwSyxXQUFXLEVBQUV4SyxNQUFNLEtBQUs7RUFDbkUsUUFBUSxPQUFPd0ssV0FBVztJQUN4QixLQUFLLFFBQVE7SUFDYixLQUFLLFFBQVE7SUFDYixLQUFLLFNBQVM7SUFDZCxLQUFLLFdBQVc7TUFDZCxPQUFPQSxXQUFXO0lBQ3BCLEtBQUssUUFBUTtJQUNiLEtBQUssVUFBVTtNQUNiLE1BQU0sdUNBQXVDO0lBQy9DLEtBQUssUUFBUTtNQUFFO1FBQ2IsSUFBSUEsV0FBVyxLQUFLLElBQUksRUFBRTtVQUN4QixPQUFPLElBQUk7UUFDYjtRQUNBLElBQUl2SixLQUFLLENBQUNDLE9BQU8sQ0FBQ3NKLFdBQVcsQ0FBQyxFQUFFO1VBQzlCLE9BQU9BLFdBQVcsQ0FBQ3JKLEdBQUcsQ0FBQ29KLG9DQUFvQyxDQUFDO1FBQzlEO1FBRUEsSUFBSTNLLEtBQUssQ0FBQzZDLE1BQU0sQ0FBQytILFdBQVcsQ0FBQyxFQUFFO1VBQzdCLE9BQU83SyxLQUFLLENBQUM4SyxPQUFPLENBQUNELFdBQVcsQ0FBQztRQUNuQztRQUVBLElBQUlBLFdBQVcsWUFBWTlLLE9BQU8sQ0FBQ2dMLElBQUksRUFBRTtVQUN2QyxPQUFPRixXQUFXLENBQUNHLFFBQVEsQ0FBQyxDQUFDO1FBQy9CO1FBRUEsSUFBSUgsV0FBVyxZQUFZOUssT0FBTyxDQUFDa0wsTUFBTSxFQUFFO1VBQ3pDLE9BQU9KLFdBQVcsQ0FBQzdKLEtBQUs7UUFDMUI7UUFFQSxJQUFJd0YsVUFBVSxDQUFDMEUscUJBQXFCLENBQUNMLFdBQVcsQ0FBQyxFQUFFO1VBQ2pELE9BQU9yRSxVQUFVLENBQUMyRSxjQUFjLENBQUNOLFdBQVcsQ0FBQztRQUMvQztRQUVBLE1BQU1qRixVQUFVLEdBQUcsQ0FBQyxDQUFDO1FBQ3JCLElBQUlpRixXQUFXLENBQUN2RixNQUFNLElBQUl1RixXQUFXLENBQUN0RixNQUFNLEVBQUU7VUFDNUNLLFVBQVUsQ0FBQ04sTUFBTSxHQUFHdUYsV0FBVyxDQUFDdkYsTUFBTSxJQUFJLEVBQUU7VUFDNUNNLFVBQVUsQ0FBQ0wsTUFBTSxHQUFHc0YsV0FBVyxDQUFDdEYsTUFBTSxJQUFJLEVBQUU7VUFDNUMsT0FBT3NGLFdBQVcsQ0FBQ3ZGLE1BQU07VUFDekIsT0FBT3VGLFdBQVcsQ0FBQ3RGLE1BQU07UUFDM0I7UUFFQSxLQUFLLElBQUkxRSxHQUFHLElBQUlnSyxXQUFXLEVBQUU7VUFDM0IsUUFBUWhLLEdBQUc7WUFDVCxLQUFLLEtBQUs7Y0FDUitFLFVBQVUsQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFLEdBQUdpRixXQUFXLENBQUNoSyxHQUFHLENBQUM7Y0FDOUM7WUFDRixLQUFLLGtCQUFrQjtjQUNyQitFLFVBQVUsQ0FBQ2lHLGdCQUFnQixHQUFHaEIsV0FBVyxDQUFDaEssR0FBRyxDQUFDO2NBQzlDO1lBQ0YsS0FBSyxNQUFNO2NBQ1Q7WUFDRixLQUFLLHFCQUFxQjtZQUMxQixLQUFLLG1CQUFtQjtZQUN4QixLQUFLLDhCQUE4QjtZQUNuQyxLQUFLLHNCQUFzQjtZQUMzQixLQUFLLFlBQVk7WUFDakIsS0FBSyxnQ0FBZ0M7WUFDckMsS0FBSyw2QkFBNkI7WUFDbEMsS0FBSyxxQkFBcUI7WUFDMUIsS0FBSyxtQkFBbUI7Y0FDdEI7Y0FDQStFLFVBQVUsQ0FBQy9FLEdBQUcsQ0FBQyxHQUFHZ0ssV0FBVyxDQUFDaEssR0FBRyxDQUFDO2NBQ2xDO1lBQ0YsS0FBSyxnQkFBZ0I7Y0FDbkIrRSxVQUFVLENBQUMsY0FBYyxDQUFDLEdBQUdpRixXQUFXLENBQUNoSyxHQUFHLENBQUM7Y0FDN0M7WUFDRixLQUFLLFdBQVc7WUFDaEIsS0FBSyxhQUFhO2NBQ2hCK0UsVUFBVSxDQUFDLFdBQVcsQ0FBQyxHQUFHNUYsS0FBSyxDQUFDOEssT0FBTyxDQUFDLElBQUkxSixJQUFJLENBQUN5SixXQUFXLENBQUNoSyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUNrRSxHQUFHO2NBQ3ZFO1lBQ0YsS0FBSyxXQUFXO1lBQ2hCLEtBQUssYUFBYTtjQUNoQmEsVUFBVSxDQUFDLFdBQVcsQ0FBQyxHQUFHNUYsS0FBSyxDQUFDOEssT0FBTyxDQUFDLElBQUkxSixJQUFJLENBQUN5SixXQUFXLENBQUNoSyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUNrRSxHQUFHO2NBQ3ZFO1lBQ0YsS0FBSyxXQUFXO1lBQ2hCLEtBQUssWUFBWTtjQUNmYSxVQUFVLENBQUMsV0FBVyxDQUFDLEdBQUc1RixLQUFLLENBQUM4SyxPQUFPLENBQUMsSUFBSTFKLElBQUksQ0FBQ3lKLFdBQVcsQ0FBQ2hLLEdBQUcsQ0FBQyxDQUFDLENBQUM7Y0FDbkU7WUFDRixLQUFLLFVBQVU7WUFDZixLQUFLLFlBQVk7Y0FDZitFLFVBQVUsQ0FBQyxVQUFVLENBQUMsR0FBRzVGLEtBQUssQ0FBQzhLLE9BQU8sQ0FBQyxJQUFJMUosSUFBSSxDQUFDeUosV0FBVyxDQUFDaEssR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDa0UsR0FBRztjQUN0RTtZQUNGLEtBQUssV0FBVztZQUNoQixLQUFLLFlBQVk7Y0FDZmEsVUFBVSxDQUFDLFdBQVcsQ0FBQyxHQUFHaUYsV0FBVyxDQUFDaEssR0FBRyxDQUFDO2NBQzFDO1lBQ0YsS0FBSyxVQUFVO2NBQ2IsSUFBSVYsU0FBUyxLQUFLLE9BQU8sRUFBRTtnQkFDekI4SCxlQUFHLENBQUM2RCxJQUFJLENBQ04sNkZBQ0YsQ0FBQztjQUNILENBQUMsTUFBTTtnQkFDTGxHLFVBQVUsQ0FBQyxVQUFVLENBQUMsR0FBR2lGLFdBQVcsQ0FBQ2hLLEdBQUcsQ0FBQztjQUMzQztjQUNBO1lBQ0Y7Y0FDRTtjQUNBLElBQUl1QyxhQUFhLEdBQUd2QyxHQUFHLENBQUNvQixLQUFLLENBQUMsOEJBQThCLENBQUM7Y0FDN0QsSUFBSW1CLGFBQWEsSUFBSWpELFNBQVMsS0FBSyxPQUFPLEVBQUU7Z0JBQzFDLElBQUlrRCxRQUFRLEdBQUdELGFBQWEsQ0FBQyxDQUFDLENBQUM7Z0JBQy9Cd0MsVUFBVSxDQUFDLFVBQVUsQ0FBQyxHQUFHQSxVQUFVLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUNyREEsVUFBVSxDQUFDLFVBQVUsQ0FBQyxDQUFDdkMsUUFBUSxDQUFDLEdBQUd3SCxXQUFXLENBQUNoSyxHQUFHLENBQUM7Z0JBQ25EO2NBQ0Y7Y0FFQSxJQUFJQSxHQUFHLENBQUNRLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUU7Z0JBQzNCLElBQUkwSyxNQUFNLEdBQUdsTCxHQUFHLENBQUNtTCxTQUFTLENBQUMsQ0FBQyxDQUFDO2dCQUM3QixJQUFJLENBQUMzTCxNQUFNLENBQUNDLE1BQU0sQ0FBQ3lMLE1BQU0sQ0FBQyxFQUFFO2tCQUMxQjlELGVBQUcsQ0FBQ0MsSUFBSSxDQUNOLGNBQWMsRUFDZCx3REFBd0QsRUFDeEQvSCxTQUFTLEVBQ1Q0TCxNQUNGLENBQUM7a0JBQ0Q7Z0JBQ0Y7Z0JBQ0EsSUFBSTFMLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDeUwsTUFBTSxDQUFDLENBQUN2TCxJQUFJLEtBQUssU0FBUyxFQUFFO2tCQUM1Q3lILGVBQUcsQ0FBQ0MsSUFBSSxDQUNOLGNBQWMsRUFDZCx1REFBdUQsRUFDdkQvSCxTQUFTLEVBQ1RVLEdBQ0YsQ0FBQztrQkFDRDtnQkFDRjtnQkFDQSxJQUFJZ0ssV0FBVyxDQUFDaEssR0FBRyxDQUFDLEtBQUssSUFBSSxFQUFFO2tCQUM3QjtnQkFDRjtnQkFDQStFLFVBQVUsQ0FBQ21HLE1BQU0sQ0FBQyxHQUFHUCxzQkFBc0IsQ0FBQ25MLE1BQU0sRUFBRTBMLE1BQU0sRUFBRWxCLFdBQVcsQ0FBQ2hLLEdBQUcsQ0FBQyxDQUFDO2dCQUM3RTtjQUNGLENBQUMsTUFBTSxJQUFJQSxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksR0FBRyxJQUFJQSxHQUFHLElBQUksUUFBUSxFQUFFO2dCQUMzQztnQkFDQW9ILGVBQUcsQ0FBQzZELElBQUksQ0FBQyxjQUFjLEVBQUUsZ0RBQWdELEVBQUUzTCxTQUFTLEVBQUVVLEdBQUcsQ0FBQztnQkFDMUY7Y0FDRixDQUFDLE1BQU07Z0JBQ0wsSUFBSUcsS0FBSyxHQUFHNkosV0FBVyxDQUFDaEssR0FBRyxDQUFDO2dCQUM1QixJQUNFUixNQUFNLENBQUNDLE1BQU0sQ0FBQ08sR0FBRyxDQUFDLElBQ2xCUixNQUFNLENBQUNDLE1BQU0sQ0FBQ08sR0FBRyxDQUFDLENBQUNMLElBQUksS0FBSyxNQUFNLElBQ2xDc0csU0FBUyxDQUFDb0UscUJBQXFCLENBQUNsSyxLQUFLLENBQUMsRUFDdEM7a0JBQ0E0RSxVQUFVLENBQUMvRSxHQUFHLENBQUMsR0FBR2lHLFNBQVMsQ0FBQ3FFLGNBQWMsQ0FBQ25LLEtBQUssQ0FBQztrQkFDakQ7Z0JBQ0Y7Z0JBQ0EsSUFDRVgsTUFBTSxDQUFDQyxNQUFNLENBQUNPLEdBQUcsQ0FBQyxJQUNsQlIsTUFBTSxDQUFDQyxNQUFNLENBQUNPLEdBQUcsQ0FBQyxDQUFDTCxJQUFJLEtBQUssVUFBVSxJQUN0Q29HLGFBQWEsQ0FBQ3NFLHFCQUFxQixDQUFDbEssS0FBSyxDQUFDLEVBQzFDO2tCQUNBNEUsVUFBVSxDQUFDL0UsR0FBRyxDQUFDLEdBQUcrRixhQUFhLENBQUN1RSxjQUFjLENBQUNuSyxLQUFLLENBQUM7a0JBQ3JEO2dCQUNGO2dCQUNBLElBQ0VYLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDTyxHQUFHLENBQUMsSUFDbEJSLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDTyxHQUFHLENBQUMsQ0FBQ0wsSUFBSSxLQUFLLFNBQVMsSUFDckNxRyxZQUFZLENBQUNxRSxxQkFBcUIsQ0FBQ2xLLEtBQUssQ0FBQyxFQUN6QztrQkFDQTRFLFVBQVUsQ0FBQy9FLEdBQUcsQ0FBQyxHQUFHZ0csWUFBWSxDQUFDc0UsY0FBYyxDQUFDbkssS0FBSyxDQUFDO2tCQUNwRDtnQkFDRjtnQkFDQSxJQUNFWCxNQUFNLENBQUNDLE1BQU0sQ0FBQ08sR0FBRyxDQUFDLElBQ2xCUixNQUFNLENBQUNDLE1BQU0sQ0FBQ08sR0FBRyxDQUFDLENBQUNMLElBQUksS0FBSyxPQUFPLElBQ25DZ0csVUFBVSxDQUFDMEUscUJBQXFCLENBQUNsSyxLQUFLLENBQUMsRUFDdkM7a0JBQ0E0RSxVQUFVLENBQUMvRSxHQUFHLENBQUMsR0FBRzJGLFVBQVUsQ0FBQzJFLGNBQWMsQ0FBQ25LLEtBQUssQ0FBQztrQkFDbEQ7Z0JBQ0Y7Y0FDRjtjQUNBNEUsVUFBVSxDQUFDL0UsR0FBRyxDQUFDLEdBQUcrSixvQ0FBb0MsQ0FBQ0MsV0FBVyxDQUFDaEssR0FBRyxDQUFDLENBQUM7VUFDNUU7UUFDRjtRQUVBLE1BQU1vTCxrQkFBa0IsR0FBR3hKLE1BQU0sQ0FBQ0MsSUFBSSxDQUFDckMsTUFBTSxDQUFDQyxNQUFNLENBQUMsQ0FBQzRMLE1BQU0sQ0FDMUQ5TCxTQUFTLElBQUlDLE1BQU0sQ0FBQ0MsTUFBTSxDQUFDRixTQUFTLENBQUMsQ0FBQ0ksSUFBSSxLQUFLLFVBQ2pELENBQUM7UUFDRCxNQUFNMkwsY0FBYyxHQUFHLENBQUMsQ0FBQztRQUN6QkYsa0JBQWtCLENBQUNuRyxPQUFPLENBQUNzRyxpQkFBaUIsSUFBSTtVQUM5Q0QsY0FBYyxDQUFDQyxpQkFBaUIsQ0FBQyxHQUFHO1lBQ2xDN0wsTUFBTSxFQUFFLFVBQVU7WUFDbEJKLFNBQVMsRUFBRUUsTUFBTSxDQUFDQyxNQUFNLENBQUM4TCxpQkFBaUIsQ0FBQyxDQUFDekY7VUFDOUMsQ0FBQztRQUNILENBQUMsQ0FBQztRQUVGLE9BQU87VUFBRSxHQUFHZixVQUFVO1VBQUUsR0FBR3VHO1FBQWUsQ0FBQztNQUM3QztJQUNBO01BQ0UsTUFBTSxpQkFBaUI7RUFDM0I7QUFDRixDQUFDO0FBRUQsSUFBSTlGLFNBQVMsR0FBRztFQUNkRSxjQUFjQSxDQUFDOEYsSUFBSSxFQUFFO0lBQ25CLE9BQU8sSUFBSWpMLElBQUksQ0FBQ2lMLElBQUksQ0FBQ3RILEdBQUcsQ0FBQztFQUMzQixDQUFDO0VBRUR1QixXQUFXQSxDQUFDdEYsS0FBSyxFQUFFO0lBQ2pCLE9BQU8sT0FBT0EsS0FBSyxLQUFLLFFBQVEsSUFBSUEsS0FBSyxLQUFLLElBQUksSUFBSUEsS0FBSyxDQUFDVCxNQUFNLEtBQUssTUFBTTtFQUMvRTtBQUNGLENBQUM7QUFFRCxJQUFJaUcsVUFBVSxHQUFHO0VBQ2Y4RixhQUFhLEVBQUUsSUFBSTVGLE1BQU0sQ0FBQyxrRUFBa0UsQ0FBQztFQUM3RjZGLGFBQWFBLENBQUM3QixNQUFNLEVBQUU7SUFDcEIsSUFBSSxPQUFPQSxNQUFNLEtBQUssUUFBUSxFQUFFO01BQzlCLE9BQU8sS0FBSztJQUNkO0lBQ0EsT0FBTyxJQUFJLENBQUM0QixhQUFhLENBQUNFLElBQUksQ0FBQzlCLE1BQU0sQ0FBQztFQUN4QyxDQUFDO0VBRURTLGNBQWNBLENBQUNULE1BQU0sRUFBRTtJQUNyQixJQUFJMUosS0FBSztJQUNULElBQUksSUFBSSxDQUFDdUwsYUFBYSxDQUFDN0IsTUFBTSxDQUFDLEVBQUU7TUFDOUIxSixLQUFLLEdBQUcwSixNQUFNO0lBQ2hCLENBQUMsTUFBTTtNQUNMMUosS0FBSyxHQUFHMEosTUFBTSxDQUFDK0IsTUFBTSxDQUFDekssUUFBUSxDQUFDLFFBQVEsQ0FBQztJQUMxQztJQUNBLE9BQU87TUFDTHpCLE1BQU0sRUFBRSxPQUFPO01BQ2ZtTSxNQUFNLEVBQUUxTDtJQUNWLENBQUM7RUFDSCxDQUFDO0VBRURrSyxxQkFBcUJBLENBQUNSLE1BQU0sRUFBRTtJQUM1QixPQUFPQSxNQUFNLFlBQVkzSyxPQUFPLENBQUM0TSxNQUFNLElBQUksSUFBSSxDQUFDSixhQUFhLENBQUM3QixNQUFNLENBQUM7RUFDdkUsQ0FBQztFQUVEbkUsY0FBY0EsQ0FBQzhGLElBQUksRUFBRTtJQUNuQixPQUFPLElBQUl0TSxPQUFPLENBQUM0TSxNQUFNLENBQUNDLE1BQU0sQ0FBQ0MsSUFBSSxDQUFDUixJQUFJLENBQUNLLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FBQztFQUMvRCxDQUFDO0VBRURwRyxXQUFXQSxDQUFDdEYsS0FBSyxFQUFFO0lBQ2pCLE9BQU8sT0FBT0EsS0FBSyxLQUFLLFFBQVEsSUFBSUEsS0FBSyxLQUFLLElBQUksSUFBSUEsS0FBSyxDQUFDVCxNQUFNLEtBQUssT0FBTztFQUNoRjtBQUNGLENBQUM7QUFFRCxJQUFJcUcsYUFBYSxHQUFHO0VBQ2xCdUUsY0FBY0EsQ0FBQ1QsTUFBTSxFQUFFO0lBQ3JCLE9BQU87TUFDTG5LLE1BQU0sRUFBRSxVQUFVO01BQ2xCMkksUUFBUSxFQUFFd0IsTUFBTSxDQUFDLENBQUMsQ0FBQztNQUNuQnpCLFNBQVMsRUFBRXlCLE1BQU0sQ0FBQyxDQUFDO0lBQ3JCLENBQUM7RUFDSCxDQUFDO0VBRURRLHFCQUFxQkEsQ0FBQ1IsTUFBTSxFQUFFO0lBQzVCLE9BQU9wSixLQUFLLENBQUNDLE9BQU8sQ0FBQ21KLE1BQU0sQ0FBQyxJQUFJQSxNQUFNLENBQUN0SSxNQUFNLElBQUksQ0FBQztFQUNwRCxDQUFDO0VBRURtRSxjQUFjQSxDQUFDOEYsSUFBSSxFQUFFO0lBQ25CLE9BQU8sQ0FBQ0EsSUFBSSxDQUFDcEQsU0FBUyxFQUFFb0QsSUFBSSxDQUFDbkQsUUFBUSxDQUFDO0VBQ3hDLENBQUM7RUFFRDVDLFdBQVdBLENBQUN0RixLQUFLLEVBQUU7SUFDakIsT0FBTyxPQUFPQSxLQUFLLEtBQUssUUFBUSxJQUFJQSxLQUFLLEtBQUssSUFBSSxJQUFJQSxLQUFLLENBQUNULE1BQU0sS0FBSyxVQUFVO0VBQ25GO0FBQ0YsQ0FBQztBQUVELElBQUlzRyxZQUFZLEdBQUc7RUFDakJzRSxjQUFjQSxDQUFDVCxNQUFNLEVBQUU7SUFDckI7SUFDQSxNQUFNb0MsTUFBTSxHQUFHcEMsTUFBTSxDQUFDaEIsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDbEksR0FBRyxDQUFDdUwsS0FBSyxJQUFJO01BQ2hELE9BQU8sQ0FBQ0EsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFQSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDN0IsQ0FBQyxDQUFDO0lBQ0YsT0FBTztNQUNMeE0sTUFBTSxFQUFFLFNBQVM7TUFDakJtSixXQUFXLEVBQUVvRDtJQUNmLENBQUM7RUFDSCxDQUFDO0VBRUQ1QixxQkFBcUJBLENBQUNSLE1BQU0sRUFBRTtJQUM1QixNQUFNb0MsTUFBTSxHQUFHcEMsTUFBTSxDQUFDaEIsV0FBVyxDQUFDLENBQUMsQ0FBQztJQUNwQyxJQUFJZ0IsTUFBTSxDQUFDbEssSUFBSSxLQUFLLFNBQVMsSUFBSSxDQUFDYyxLQUFLLENBQUNDLE9BQU8sQ0FBQ3VMLE1BQU0sQ0FBQyxFQUFFO01BQ3ZELE9BQU8sS0FBSztJQUNkO0lBQ0EsS0FBSyxJQUFJeEssQ0FBQyxHQUFHLENBQUMsRUFBRUEsQ0FBQyxHQUFHd0ssTUFBTSxDQUFDMUssTUFBTSxFQUFFRSxDQUFDLEVBQUUsRUFBRTtNQUN0QyxNQUFNd0csS0FBSyxHQUFHZ0UsTUFBTSxDQUFDeEssQ0FBQyxDQUFDO01BQ3ZCLElBQUksQ0FBQ3NFLGFBQWEsQ0FBQ3NFLHFCQUFxQixDQUFDcEMsS0FBSyxDQUFDLEVBQUU7UUFDL0MsT0FBTyxLQUFLO01BQ2Q7TUFDQTlJLEtBQUssQ0FBQzJKLFFBQVEsQ0FBQ0MsU0FBUyxDQUFDb0QsVUFBVSxDQUFDbEUsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUVrRSxVQUFVLENBQUNsRSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN0RTtJQUNBLE9BQU8sSUFBSTtFQUNiLENBQUM7RUFFRHZDLGNBQWNBLENBQUM4RixJQUFJLEVBQUU7SUFDbkIsSUFBSVMsTUFBTSxHQUFHVCxJQUFJLENBQUMzQyxXQUFXO0lBQzdCO0lBQ0EsSUFDRW9ELE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBS0EsTUFBTSxDQUFDQSxNQUFNLENBQUMxSyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQzdDMEssTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLQSxNQUFNLENBQUNBLE1BQU0sQ0FBQzFLLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFDN0M7TUFDQTBLLE1BQU0sQ0FBQ0csSUFBSSxDQUFDSCxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDeEI7SUFDQSxNQUFNSSxNQUFNLEdBQUdKLE1BQU0sQ0FBQ1osTUFBTSxDQUFDLENBQUNpQixJQUFJLEVBQUVDLEtBQUssRUFBRUMsRUFBRSxLQUFLO01BQ2hELElBQUlDLFVBQVUsR0FBRyxDQUFDLENBQUM7TUFDbkIsS0FBSyxJQUFJaEwsQ0FBQyxHQUFHLENBQUMsRUFBRUEsQ0FBQyxHQUFHK0ssRUFBRSxDQUFDakwsTUFBTSxFQUFFRSxDQUFDLElBQUksQ0FBQyxFQUFFO1FBQ3JDLE1BQU1pTCxFQUFFLEdBQUdGLEVBQUUsQ0FBQy9LLENBQUMsQ0FBQztRQUNoQixJQUFJaUwsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLSixJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUlJLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBS0osSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFO1VBQzFDRyxVQUFVLEdBQUdoTCxDQUFDO1VBQ2Q7UUFDRjtNQUNGO01BQ0EsT0FBT2dMLFVBQVUsS0FBS0YsS0FBSztJQUM3QixDQUFDLENBQUM7SUFDRixJQUFJRixNQUFNLENBQUM5SyxNQUFNLEdBQUcsQ0FBQyxFQUFFO01BQ3JCLE1BQU0sSUFBSXBDLEtBQUssQ0FBQzJDLEtBQUssQ0FDbkIzQyxLQUFLLENBQUMyQyxLQUFLLENBQUNvRSxxQkFBcUIsRUFDakMsdURBQ0YsQ0FBQztJQUNIO0lBQ0E7SUFDQStGLE1BQU0sR0FBR0EsTUFBTSxDQUFDdEwsR0FBRyxDQUFDdUwsS0FBSyxJQUFJO01BQzNCLE9BQU8sQ0FBQ0EsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFQSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDN0IsQ0FBQyxDQUFDO0lBQ0YsT0FBTztNQUFFdk0sSUFBSSxFQUFFLFNBQVM7TUFBRWtKLFdBQVcsRUFBRSxDQUFDb0QsTUFBTTtJQUFFLENBQUM7RUFDbkQsQ0FBQztFQUVEeEcsV0FBV0EsQ0FBQ3RGLEtBQUssRUFBRTtJQUNqQixPQUFPLE9BQU9BLEtBQUssS0FBSyxRQUFRLElBQUlBLEtBQUssS0FBSyxJQUFJLElBQUlBLEtBQUssQ0FBQ1QsTUFBTSxLQUFLLFNBQVM7RUFDbEY7QUFDRixDQUFDO0FBRUQsSUFBSXVHLFNBQVMsR0FBRztFQUNkcUUsY0FBY0EsQ0FBQ1QsTUFBTSxFQUFFO0lBQ3JCLE9BQU87TUFDTG5LLE1BQU0sRUFBRSxNQUFNO01BQ2RpTixJQUFJLEVBQUU5QztJQUNSLENBQUM7RUFDSCxDQUFDO0VBRURRLHFCQUFxQkEsQ0FBQ1IsTUFBTSxFQUFFO0lBQzVCLE9BQU8sT0FBT0EsTUFBTSxLQUFLLFFBQVE7RUFDbkMsQ0FBQztFQUVEbkUsY0FBY0EsQ0FBQzhGLElBQUksRUFBRTtJQUNuQixPQUFPQSxJQUFJLENBQUNtQixJQUFJO0VBQ2xCLENBQUM7RUFFRGxILFdBQVdBLENBQUN0RixLQUFLLEVBQUU7SUFDakIsT0FBTyxPQUFPQSxLQUFLLEtBQUssUUFBUSxJQUFJQSxLQUFLLEtBQUssSUFBSSxJQUFJQSxLQUFLLENBQUNULE1BQU0sS0FBSyxNQUFNO0VBQy9FO0FBQ0YsQ0FBQztBQUVEa04sTUFBTSxDQUFDQyxPQUFPLEdBQUc7RUFDZnhOLFlBQVk7RUFDWnNFLGlDQUFpQztFQUNqQ1UsZUFBZTtFQUNmL0IsY0FBYztFQUNkeUksd0JBQXdCO0VBQ3hCakksbUJBQW1CO0VBQ25CNkg7QUFDRixDQUFDIiwiaWdub3JlTGlzdCI6W119