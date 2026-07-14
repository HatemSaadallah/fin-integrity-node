export class FinIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinIntegrityError";
  }
}

/** Thrown at init() for invalid configuration (fail fast). Runtime capture never throws. */
export class ConfigError extends FinIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
