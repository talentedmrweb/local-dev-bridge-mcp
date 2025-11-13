#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';
import os from 'os';

const execAsync = promisify(exec);

// Get the base directory for projects (configurable via environment variable)
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(os.homedir(), 'Desktop', 'Projects');

class LocalDevBridgeServer {
  constructor() {
    this.server = new Server(
      {
        name: 'local-dev-bridge-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'read_file',
          description: 'Read the contents of a file from the local file system. Use this to view existing code files.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file (relative to projects directory or absolute)',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Create or overwrite a file with new content. Use this to create new files or completely replace existing ones.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file (relative to projects directory or absolute)',
              },
              content: {
                type: 'string',
                description: 'Content to write to the file',
              },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'edit_file',
          description: 'Edit a file by replacing specific text. The old_text must match exactly (including whitespace).',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file',
              },
              old_text: {
                type: 'string',
                description: 'Text to find and replace (must match exactly)',
              },
              new_text: {
                type: 'string',
                description: 'Text to replace it with',
              },
            },
            required: ['path', 'old_text', 'new_text'],
          },
        },
        {
          name: 'list_directory',
          description: 'List files and directories in a given path',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to directory (relative to projects directory or absolute)',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'run_command',
          description: 'Execute a shell command in the projects directory. Use for running npm install, git commands, tests, etc.',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Shell command to execute',
              },
              cwd: {
                type: 'string',
                description: 'Working directory (relative to projects directory or absolute)',
              },
            },
            required: ['command'],
          },
        },
        {
          name: 'search_files',
          description: 'Search for text within files in a directory (recursive)',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Text to search for',
              },
              path: {
                type: 'string',
                description: 'Directory to search in (defaults to projects directory)',
              },
              file_pattern: {
                type: 'string',
                description: "File pattern to match (e.g., '*.js', '*.py')",
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'read_file':
            return await this.readFile(args.path);
          
          case 'write_file':
            return await this.writeFile(args.path, args.content);
          
          case 'edit_file':
            return await this.editFile(args.path, args.old_text, args.new_text);
          
          case 'list_directory':
            return await this.listDirectory(args.path);
          
          case 'run_command':
            return await this.runCommand(args.command, args.cwd);
          
          case 'search_files':
            return await this.searchFiles(args.query, args.path, args.file_pattern);
          
          default:
            return {
              content: [
                {
                  type: 'text',
                  text: `Unknown tool: ${name}`,
                },
              ],
            };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  resolvePath(inputPath) {
    if (!inputPath || inputPath === '.') {
      return PROJECTS_DIR;
    }
    if (path.isAbsolute(inputPath)) {
      return inputPath;
    }
    return path.join(PROJECTS_DIR, inputPath);
  }

  async readFile(filePath) {
    const resolvedPath = this.resolvePath(filePath);
    const content = await fs.readFile(resolvedPath, 'utf-8');
    return {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
    };
  }

  async writeFile(filePath, content) {
    const resolvedPath = this.resolvePath(filePath);
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resolvedPath, content, 'utf-8');
    return {
      content: [
        {
          type: 'text',
          text: `File written successfully: ${resolvedPath}`,
        },
      ],
    };
  }

  async editFile(filePath, oldText, newText) {
    const resolvedPath = this.resolvePath(filePath);
    let content = await fs.readFile(resolvedPath, 'utf-8');
    
    if (!content.includes(oldText)) {
      throw new Error(`Text not found in file: ${oldText.substring(0, 50)}...`);
    }
    
    content = content.replace(oldText, newText);
    await fs.writeFile(resolvedPath, content, 'utf-8');
    
    return {
      content: [
        {
          type: 'text',
          text: `File edited successfully: ${resolvedPath}`,
        },
      ],
    };
  }

  async listDirectory(dirPath) {
    const resolvedPath = this.resolvePath(dirPath);
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    
    const items = entries.map((entry) => {
      const icon = entry.isDirectory() ? '📁' : '📄';
      return `${icon} ${entry.name}`;
    });
    
    return {
      content: [
        {
          type: 'text',
          text: `Contents of ${resolvedPath}:\n\n${items.join('\n')}`,
        },
      ],
    };
  }

  async runCommand(command, cwd) {
    const resolvedCwd = cwd ? this.resolvePath(cwd) : PROJECTS_DIR;
    const { stdout, stderr } = await execAsync(command, { cwd: resolvedCwd });
    
    let output = '';
    if (stdout) output += `Output:\n${stdout}\n`;
    if (stderr) output += `Errors:\n${stderr}\n`;
    
    return {
      content: [
        {
          type: 'text',
          text: output || 'Command executed successfully (no output)',
        },
      ],
    };
  }

  async searchFiles(query, searchPath, filePattern = '*') {
    const resolvedPath = this.resolvePath(searchPath || '.');
    const pattern = path.join(resolvedPath, '**', filePattern);
    
    const files = await glob(pattern, { 
      ignore: ['**/node_modules/**', '**/.git/**'],
      nodir: true,
    });
    
    const results = [];
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            results.push(`${file}:${index + 1}:${line.trim()}`);
          }
        });
      } catch (error) {
        // Skip files that can't be read
      }
    }
    
    const output = results.length > 0 
      ? `Search results for "${query}" in ${resolvedPath}:\n\n${results.slice(0, 100).join('\n')}`
      : `No results found for "${query}" in ${resolvedPath}`;
    
    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Local Dev Bridge MCP Server running on stdio');
  }
}

const server = new LocalDevBridgeServer();
server.run().catch(console.error);
