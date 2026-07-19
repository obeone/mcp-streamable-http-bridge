import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { LOG_FILE_PATH } from './paths.js';

function parseMaxFiles(value) {
  const n = Number(value ?? '5');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/**
 * @typedef {Object} LoggerFactoryOptions
 * @property {string} [logFilePath]
 */

export class LoggerFactory {
  /**
   * @param {LoggerFactoryOptions} [options]
   */
  static create(options = {}) {
    const level = process.env.LOG_LEVEL ?? 'info';
    const filename = options.logFilePath ?? LOG_FILE_PATH;
    const maxSize = process.env.LOG_MAX_SIZE ?? '10m';
    const maxFiles = parseMaxFiles(process.env.LOG_MAX_FILES);

    const dir = path.dirname(filename);
    fs.mkdirSync(dir, { recursive: true });

    const lineFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} ${level}: ${message}${extra}`;
    });

    const fileFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      lineFormat
    );

    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp(),
      lineFormat
    );

    /** @type {winston.transport[]} */
    const transports = [
      new DailyRotateFile({
        filename,
        frequency: 'dont-rotate',
        maxSize,
        maxFiles,
        createSymlink: false,
        zippedArchive: false,
        auditFile: path.join(dir, '.mcp-wrapper-log-audit.json'),
        format: fileFormat,
      }),
      new winston.transports.Console({
        format: consoleFormat,
      }),
    ];

    return winston.createLogger({
      level,
      transports,
    });
  }
}
