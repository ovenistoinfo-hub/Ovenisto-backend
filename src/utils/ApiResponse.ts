/**
 * Standardized API Response Helper
 * Ensures consistent response format across all endpoints
 */

export interface ApiResponseData<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  errors?: Array<{ field: string; message: string }>;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

export class ApiResponse {
  /**
   * Send success response
   */
  static success<T>(data: T, message?: string): ApiResponseData<T> {
    return {
      success: true,
      data,
      message,
    };
  }

  /**
   * Send paginated response
   */
  static paginated<T>(
    data: T[],
    page: number,
    limit: number,
    total: number
  ): ApiResponseData<T[]> {
    return {
      success: true,
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Send error response
   */
  static error(
    message: string,
    errors?: Array<{ field: string; message: string }>
  ): ApiResponseData {
    return {
      success: false,
      error: message,
      errors,
    };
  }

  /**
   * Send created response (201)
   */
  static created<T>(data: T, message = 'Created successfully'): ApiResponseData<T> {
    return {
      success: true,
      data,
      message,
    };
  }

  /**
   * Send no content response data (for 204)
   */
  static noContent(): null {
    return null;
  }
}
