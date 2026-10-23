'use strict';

/**
 * An expected, user-facing failure (validation, insufficient balance, wrong state...).
 * Its message is safe to show to the user; anything else is logged and replaced
 * by a generic message.
 */
class UserError extends Error {
  constructor(message, code = 'USER_ERROR') {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

module.exports = { UserError };
