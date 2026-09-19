// Only deliberately public errors may cross the HTTP boundary.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
