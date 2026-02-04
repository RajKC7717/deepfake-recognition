export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

class Logger {
  private level: LogLevel = LogLevel.DEBUG;
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  debug(...args: any[]) {
    if (this.level <= LogLevel.DEBUG) {
      console.log(`[${this.prefix}] 🔍`, ...args);
    }
  }

  info(...args: any[]) {
    if (this.level <= LogLevel.INFO) {
      console.info(`[${this.prefix}] ℹ️`, ...args);
    }
  }

  warn(...args: any[]) {
    if (this.level <= LogLevel.WARN) {
      console.warn(`[${this.prefix}] ⚠️`, ...args);
    }
  }

  error(...args: any[]) {
    if (this.level <= LogLevel.ERROR) {
      console.error(`[${this.prefix}] ❌`, ...args);
    }
  }
}

export const createLogger = (prefix: string) => new Logger(prefix);