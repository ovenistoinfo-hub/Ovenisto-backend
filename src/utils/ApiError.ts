/**
 * Custom API Error Class
 * Extends Error with HTTP status codes for consistent error handling
 */

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly errors?: Array<{ field: string; message: string }>;

  constructor(
    message: string,
    statusCode = 500,
    isOperational = true,
    errors?: Array<{ field: string; message: string }>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.errors = errors;

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);

    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /**
   * 400 Bad Request
   */
  static badRequest(
    message = 'Bad Request',
    errors?: Array<{ field: string; message: string }>
  ): ApiError {
    return new ApiError(message, 400, true, errors);
  }

  /**
   * 401 Unauthorized
   */
  static unauthorized(message = 'Unauthorized'): ApiError {
    return new ApiError(message, 401);
  }

  /**
   * 403 Forbidden
   */
  static forbidden(message = 'Forbidden'): ApiError {
    return new ApiError(message, 403);
  }

  /**
   * 404 Not Found
   */
  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(message, 404);
  }

  /**
   * 409 Conflict
   */
  static conflict(message = 'Conflict'): ApiError {
    return new ApiError(message, 409);
  }

  /**
   * 422 Unprocessable Entity (Validation Error)
   */
  static validationError(
    message = 'Validation failed',
    errors?: Array<{ field: string; message: string }>
  ): ApiError {
    return new ApiError(message, 422, true, errors);
  }

  /**
   * 429 Too Many Requests
   */
  static tooManyRequests(message = 'Too many requests'): ApiError {
    return new ApiError(message, 429);
  }

  /**
   * 500 Internal Server Error
   */
  static internal(message = 'Internal server error'): ApiError {
    return new ApiError(message, 500, false);
  }
}
