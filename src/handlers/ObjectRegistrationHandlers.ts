import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import type { ToolDefinition } from '../types/tools';

export class ObjectRegistrationHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'objectRegistrationInfo',
        description: 'Get registration information for an ABAP object',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrl: { type: 'string' }
          },
          required: ['objectUrl']
        }
      },
      {
        name: 'validateNewObject',
        description: 'Validate parameters for a new ABAP object. Fields vary by objtype: non-grouped types need packagename; function-group children need fugrname; packages (DEVC/K) need packagename + swcomp + transportLayer + packagetype.',
        inputSchema: {
          type: 'object',
          properties: {
            objtype: { type: 'string', description: 'CreatableTypeId (e.g. "DEVC/K", "DTEL/DE", "CLAS/OC")' },
            objname: { type: 'string', description: 'Name of the new object' },
            description: { type: 'string' },
            packagename: { type: 'string', description: 'Parent package. Required for non-grouped types and for DEVC/K (the SUPER package).' },
            fugrname: { type: 'string', description: 'Parent function group. Required for FUGR/FF and FUGR/I.' },
            swcomp: { type: 'string', description: 'Software component. Required when objtype = DEVC/K.' },
            transportLayer: { type: 'string', description: 'Transport layer. Required when objtype = DEVC/K.' },
            packagetype: { type: 'string', description: '"development" | "structure" | "main". Required when objtype = DEVC/K.' },
            service: { type: 'string', description: 'For SRVB/SVB only.' },
            serviceBindingVersion: { type: 'string', description: 'For SRVB/SVB only (e.g. "ODATA\\\\V2").' },
            serviceDefinition: { type: 'string', description: 'For SRVB/SVB only.' },
            package: { type: 'string', description: 'For SRVB/SVB only.' }
          },
          required: ['objtype', 'objname', 'description']
        }
      },
      {
        name: 'createObject',
        description: 'Create a new ABAP object. For packages (DEVC/K) you MUST also supply swcomp, transportLayer, and packagetype - the SDK rejects DEVC/K without them ("Can\'t create a Package with incomplete data").',
        inputSchema: {
          type: 'object',
          properties: {
            objtype: { type: 'string', description: 'CreatableTypeId (e.g. "DEVC/K", "DTEL/DE", "CLAS/OC")' },
            name: { type: 'string' },
            parentName: { type: 'string', description: 'For non-package objects: containing package. For DEVC/K: super-package (use empty string or a top-level package).' },
            description: { type: 'string' },
            parentPath: { type: 'string', description: 'ADT URL of the parent (e.g. "/sap/bc/adt/packages/<NAME>")' },
            responsible: { type: 'string', optional: true },
            transport: { type: 'string', optional: true },
            swcomp: { type: 'string', description: 'Software component. REQUIRED when objtype = DEVC/K (e.g. "HOME", "LOCAL", "ZCUSTOMER").', optional: true },
            transportLayer: { type: 'string', description: 'Transport layer. REQUIRED when objtype = DEVC/K (e.g. "SAP", "ZDEV").', optional: true },
            packagetype: { type: 'string', description: '"development" | "structure" | "main". REQUIRED when objtype = DEVC/K.', optional: true }
          },
          required: ['objtype', 'name', 'parentName', 'description', 'parentPath']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'objectRegistrationInfo':
        return this.handleObjectRegistrationInfo(args);
      case 'validateNewObject':
        return this.handleValidateNewObject(args);
      case 'createObject':
        return this.handleCreateObject(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object registration tool: ${toolName}`);
    }
  }

  async handleObjectRegistrationInfo(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const info = await this.adtclient.objectRegistrationInfo(args.objectUrl);
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            info
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get registration info: ${error.message || 'Unknown error'}`
      );
    }
  }

  async handleValidateNewObject(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const options: any = {
        objtype: args.objtype,
        objname: args.objname,
        description: args.description
      };
      if (args.packagename !== undefined)           options.packagename = args.packagename;
      if (args.fugrname !== undefined)              options.fugrname = args.fugrname;
      if (args.swcomp !== undefined)                options.swcomp = args.swcomp;
      if (args.transportLayer !== undefined)        options.transportLayer = args.transportLayer;
      if (args.packagetype !== undefined)           options.packagetype = args.packagetype;
      if (args.service !== undefined)               options.service = args.service;
      if (args.serviceBindingVersion !== undefined) options.serviceBindingVersion = args.serviceBindingVersion;
      if (args.serviceDefinition !== undefined)     options.serviceDefinition = args.serviceDefinition;
      if (args.package !== undefined)               options.package = args.package;

      const result = await this.adtclient.validateNewObject(options);
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            options,
            result
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to validate new object: ${error.message || 'Unknown error'}`
      );
    }
  }

  async handleCreateObject(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const options: any = {
        objtype: args.objtype,
        name: args.name,
        parentName: args.parentName,
        description: args.description,
        parentPath: args.parentPath
      };
      if (args.responsible !== undefined) options.responsible = args.responsible;
      if (args.transport !== undefined)   options.transport = args.transport;

      if (args.objtype === 'DEVC/K') {
        const missing: string[] = [];
        if (!args.swcomp)         missing.push('swcomp');
        if (!args.transportLayer) missing.push('transportLayer');
        if (!args.packagetype)    missing.push('packagetype');
        if (missing.length > 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Creating a package (DEVC/K) requires the following additional fields: ${missing.join(', ')}. ` +
            `Example: swcomp="HOME", transportLayer="SAP", packagetype="development".`
          );
        }
        options.swcomp = args.swcomp;
        options.transportLayer = args.transportLayer;
        options.packagetype = args.packagetype;
      }

      const result = await this.adtclient.createObject(options);
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            options,
            result
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create object: ${error.message || 'Unknown error'}`
      );
    }
  }
}
