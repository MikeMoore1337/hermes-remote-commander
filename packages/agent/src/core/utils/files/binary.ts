/**
 * Binary file handler
 * Handles binary files that aren't supported by other handlers (Excel, Image)
 * Uses isBinaryFile for content-based detection
 * Reports unsupported binary reads as an error with guidance for safe tools
 */

import fs from "fs/promises";
import path from "path";
import { isBinaryFile } from 'isbinaryfile';
import {
    FileHandler,
    ReadOptions,
    FileResult,
    FileInfo
} from './base.js';

/**
 * Binary file handler implementation
 * Uses content-based detection via isBinaryFile
 */
export class BinaryFileHandler implements FileHandler {
    async canHandle(filePath: string): Promise<boolean> {
        // Content-based binary detection using isBinaryFile
        try {
            return await isBinaryFile(filePath);
        } catch (error) {
            // If we can't check (file doesn't exist, etc.), don't handle it
            return false;
        }
    }

    async read(filePath: string, options?: ReadOptions): Promise<FileResult> {
        // Unsupported binary content must be surfaced as an MCP error, not
        // silently returned as a successful text file.
        throw new Error(this.getBinaryInstructions(filePath));
    }

    async write(path: string, content: any): Promise<void> {
        throw new Error('Cannot write binary files directly. Use start_process with appropriate tools (Python, Node.js libraries, command-line utilities).');
    }

    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            permissions: stats.mode.toString(8).slice(-3),
            fileType: 'binary',
            metadata: {
                isBinary: true
            }
        };
    }

    /**
     * Generate instructions for handling binary files
     */
    private getBinaryInstructions(filePath: string): string {
        const fileName = path.basename(filePath);

        return `Cannot read binary file as text: ${fileName}

Use start_process + interact_with_process to analyze binary files with appropriate tools (Node.js or Python libraries, command-line utilities, etc.).

The read_file tool only handles text files, images, and Excel files.`;
    }
}
