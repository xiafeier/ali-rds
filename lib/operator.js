'use strict';

/**
 * Module dependencies.
 */

const debug = require('debug')('ali-rds:operator');
const SqlString = require('./sqlstring');
const literals = require('./literals');
const wrap = require('co-wrap-all');

module.exports = Operator;

/**
 * Operator Interface
 */
function Operator() {}

const proto = Operator.prototype;

proto.literals = literals;

proto.escape = function(value, stringifyObjects, timeZone) {
  return SqlString.escape(value, stringifyObjects, timeZone);
};

proto.escapeId = function(value, forbidQualified) {
  return SqlString.escapeId(value, forbidQualified);
};

proto.format = function(sql, values, stringifyObjects, timeZone) {
  // if values is object, not null, not Array;
  if (!Array.isArray(values) && typeof values === 'object' && values !== null) {
    // object not support replace column like ??;
    return sql.replace(/\:(\w+)/g, function(txt, key) {
      if (values.hasOwnProperty(key)) {
        return SqlString.escape(values[key]);
      }
      // if values don't hasOwnProperty, return origin txt;
      return txt;
    });
  }
  return SqlString.format(sql, values, stringifyObjects, timeZone);

};

proto.query = function* (sql, values) {
  // query(sql, values)
  if (arguments.length >= 2) {
    sql = this.format(sql, values);
  }
  debug('query %j', sql);
  try {
    const rows = yield this._query(sql);
    debug('query get %d rows', rows.length);
    return rows;
  } catch (err) {
    err.stack = err.stack + '\n    sql: ' + sql;
    debug('query error: %s', err);
    throw err;
  }
};

proto.queryOne = function* (sql, values) {
  const rows = yield this.query(sql, values);
  return rows && rows[0] || null;
};

proto._query = function(/* sql */) {
  throw new Error('SubClass must impl this');
};

proto.count = function* (table, where) {
  const sql = this.format('SELECT COUNT(*) as count FROM ??', [ table ]) +
    this._where(where);
  debug('count(%j, %j) \n=> %j', table, where, sql);
  const rows = yield this.query(sql);
  return rows[0].count;
};

/**
 * Select rows from a table
 *
 * @param  {String} table     table name
 * @param  {Object} [options] optional params
 *  - {Object} where          query condition object
 *  - {Array|String} columns  select columns, default is `'*'`
 *  - {Array|String} orders   result rows sort condition
 *  - {Number} limit          result limit count, default is no limit
 *  - {Number} offset         result offset, default is `0`
 * @return {Array} result rows
 */
proto.select = function* (table, options) {
  options = options || {};
  const sql = this._selectColumns(table, options.columns) +
    this._where(options.where) +
    this._orders(options.orders) +
    this._limit(options.limit, options.offset);
  debug('select(%j, %j) \n=> %j', table, options, sql);
  return yield this.query(sql);
};

proto.get = function* (table, where, options) {
  options = options || {};
  options.where = where;
  options.limit = 1;
  options.offset = 0;
  const rows = yield this.select(table, options);
  return rows && rows[0] || null;
};

proto.insert = function* (table, rows, options) {
  options = options || {};
  let firstObj;
  // insert(table, rows)
  if (Array.isArray(rows)) {
    firstObj = rows[0];
  } else {
    // insert(table, row)
    firstObj = rows;
    rows = [ rows ];
  }
  if (!options.columns) {
    options.columns = Object.keys(firstObj);
  }

  const params = [ table, options.columns ];
  const strs = [];
  for (let i = 0; i < rows.length; i++) {
    const values = [];
    const row = rows[i];
    for (let j = 0; j < options.columns.length; j++) {
      values.push(row[options.columns[j]]);
    }
    strs.push('(?)');
    params.push(values);
  }

  const sql = this.format('INSERT INTO ??(??) VALUES' + strs.join(', '), params);
  debug('insert(%j, %j, %j) \n=> %j', table, rows, options, sql);
  return yield this.query(sql);
};

proto.update = function* (table, row, options) {
  // TODO: support multi rows
  options = options || {};
  if (!options.columns) {
    options.columns = Object.keys(row);
  }
  if (!options.where) {
    if (!('id' in row)) {
      throw new Error('Can\'t not auto detect update condition, please set options.where, or make sure obj.id exists');
    }
    options.where = {
      id: row.id,
    };
  }

  const sets = [];
  const values = [];
  for (let i = 0; i < options.columns.length; i++) {
    const column = options.columns[i];
    if (column in options.where) {
      continue;
    }
    sets.push('?? = ?');
    values.push(column);
    values.push(row[column]);
  }
  const sql = this.format('UPDATE ?? SET ', [ table ]) +
    this.format(sets.join(', '), values) +
    this._where(options.where);
  debug('update(%j, %j, %j) \n=> %j', table, row, options, sql);
  return yield this.query(sql);
};

proto.delete = function* (table, where) {
  const sql = this.format('DELETE FROM ??', [ table ]) +
    this._where(where);
  debug('delete(%j, %j) \n=> %j', table, where, sql);
  return yield this.query(sql);
};

proto._where = function(where) {
  if (!where) {
    return '';
  }

  const wheres = [];
  const values = [];
  for (const key in where) {
    const value = where[key];
    if (Array.isArray(value)) {
      wheres.push('?? IN (?)');
    } else {
      wheres.push('?? = ?');
    }
    values.push(key);
    values.push(value);
  }
  if (wheres.length > 0) {
    return this.format(' WHERE ' + wheres.join(' AND '), values);
  }
  return '';

};

proto._selectColumns = function(table, columns) {
  if (!columns) {
    columns = '*';
  }
  let sql;
  if (columns === '*') {
    sql = this.format('SELECT * FROM ??', [ table ]);
  } else {
    sql = this.format('SELECT ?? FROM ??', [ columns, table ]);
  }
  return sql;
};

proto._orders = function(orders) {
  if (!orders) {
    return '';
  }
  if (typeof orders === 'string') {
    orders = [ orders ];
  }
  const values = [];
  for (let i = 0; i < orders.length; i++) {
    const value = orders[i];
    if (typeof value === 'string') {
      values.push(this.escapeId(value));
    } else if (Array.isArray(value)) {
      // value format: ['name', 'desc'], ['name'], ['name', 'asc']
      let sort = String(value[1]).toUpperCase();
      if (sort !== 'ASC' && sort !== 'DESC') {
        sort = null;
      }
      if (sort) {
        values.push(this.escapeId(value[0]) + ' ' + sort);
      } else {
        values.push(this.escapeId(value[0]));
      }
    }
  }
  return ' ORDER BY ' + values.join(', ');
};

proto._limit = function(limit, offset) {
  if (!limit || typeof limit !== 'number') {
    return '';
  }
  if (typeof offset !== 'number') {
    offset = 0;
  }
  return ' LIMIT ' + offset + ', ' + limit;
};

wrap(proto);
