import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ADTClient } from "abap-adt-api";
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { getTargetClient, targetClientStatus, resetTargetClient } from '../lib/targetClient.js';

// Object types creatable via ADT createObject() that this importer supports.
// Forms (SAPscript / Smart Forms / Adobe Forms) are NOT in this list because
// the abap-adt-api SDK does not expose creation/layout APIs for them.
const SUPPORTED_IMPORT_TYPES = new Set<string>([
  'DTEL/DE',  // Data Element
  'TABL/DT',  // Database Table / Structure
  'CLAS/OC',  // Class
  'INTF/OI',  // Interface
  'PROG/P',   // Program
  'PROG/I',   // Include
  'MSAG/N',   // Message Class
  'DDLS/DF',  // CDS DDL Source
  'DCLS/DL',  // CDS Access Control
  'DDLX/EX'   // CDS Metadata Extension
]);

// Form-related types we explicitly probe but cannot create via ADT.
const FORM_TYPES = new Set<string>([
  'SFPI/IF', 'SFPF/FO',    // Adobe Form interface/form
  'FORM/F',  'FORM',        // SAPscript form
  'SSFO/SF', 'SSFO'         // Smart Form
]);

interface BundleItemSource {
  sourceUri: string;
  includeType?: string;
  source: string;
}

interface BundleItem {
  objectUrl: string;
  name: string;
  type: string;
  package?: string;
  description?: string;
  responsible?: string;
  language?: string;
  structure: any;
  sources: BundleItemSource[];
  errors: string[];
}

interface Bundle {
  generatedAt: string;
  sourceSystem: { url: string; user: string; client: string };
  items: BundleItem[];
}

export class MigrationHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'migrationTargetStatus',
        description: 'Report whether TARGET_SAP_* env vars are configured and whether the target ADT client is currently logged in',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'migrationLoginTarget',
        description: 'Log in to the target SAP system (TARGET_SAP_* env vars)',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'migrationLogoutTarget',
        description: 'Log out of the target SAP system and reset the cached client',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'exportObjectBundle',
        description: 'Read full structure + source for a list of ADT object URLs from the source system. Returns a JSON bundle suitable for importObjectBundle, audit hand-off to Basis, or compareObjectSource.',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrls: {
              type: 'array',
              description: 'ADT object URLs to export (e.g. "/sap/bc/adt/ddic/dataelements/ZDE_LEADTIME")'
            },
            continueOnError: {
              type: 'boolean',
              description: 'When true, an error on one object is recorded in its bundle entry and processing continues. Default true.'
            }
          },
          required: ['objectUrls']
        }
      },
      {
        name: 'importObjectBundle',
        description: 'Create objects on the target SAP system from a bundle produced by exportObjectBundle. Only types in the supported list are created; forms and other non-creatable types are skipped with a reason. Each created object\'s source is written under the supplied transport.',
        inputSchema: {
          type: 'object',
          properties: {
            bundle: { type: 'object', description: 'Bundle JSON produced by exportObjectBundle' },
            targetPackage: { type: 'string', description: 'Package on the target system that will own the created objects' },
            targetTransport: { type: 'string', description: 'Transport request on the target system to record the new objects in. Required for non-local packages.' },
            responsible: { type: 'string', description: 'Override the responsible user on target (default: original from bundle)' },
            dryRun: { type: 'boolean', description: 'When true, validate + report what would be done but make no writes. Default false.' }
          },
          required: ['bundle', 'targetPackage']
        }
      },
      {
        name: 'probeFormObject',
        description: 'Audit what ADT exposes for a form object (Adobe Form / Smart Form / SAPscript). Captures structure, path, and any reachable source. Use this to produce a hand-off report for Basis when full MCP migration is not possible.',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrl: { type: 'string', description: 'ADT URL of the form object' }
          },
          required: ['objectUrl']
        }
      },
      {
        name: 'compareObjectSource',
        description: 'Fetch the source of an object from both the source and target SAP systems and report whether they match. Useful for verifying a migration step.',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrl: { type: 'string', description: 'ADT URL of the object (must resolve on both systems)' },
            sourceUri: { type: 'string', description: 'Optional explicit source URI; if omitted, derived from objectStructure on the source system' }
          },
          required: ['objectUrl']
        }
      },
      {
        name: 'discoverDependencies',
        description: 'Given a list of ADT object URLs, return a flat list of their packages and metadata. Useful for pre-flight verification that all objects belong to the expected scope before exporting.',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrls: { type: 'array' }
          },
          required: ['objectUrls']
        }
      },
      {
        name: 'createTargetTransport',
        description: 'Create a new transport request on the TARGET system bound to a single seed object. Use this when the target package needs a fresh TR to receive imported objects.',
        inputSchema: {
          type: 'object',
          properties: {
            seedObjectUrl: { type: 'string', description: 'A URL on target whose package will own the TR (e.g. the target package URL or an existing object inside it)' },
            description: { type: 'string', description: 'Transport description / REQUEST_TEXT' },
            devClass: { type: 'string', description: 'Target package (DEVCLASS)' },
            transportLayer: { type: 'string', description: 'Optional transport layer' }
          },
          required: ['seedObjectUrl', 'description', 'devClass']
        }
      },
      {
        name: 'transportInsertObject',
        description: 'Add an unmodified existing object to an EXISTING modifiable transport request. Tries the ADT transportReference endpoint first; verifies via SELECT on E071; optionally falls back to a no-op save (reads source, locks, writes the same source back under the TR, unlocks) when allowSaveBasedFallback=true.',
        inputSchema: {
          type: 'object',
          properties: {
            pgmid: { type: 'string', description: 'TADIR PGMID, usually "R3TR"' },
            obj_wbtype: { type: 'string', description: 'Workbench object type (e.g. "DTEL", "TABL", "CLAS"). Use the bare type, not "DTEL/DE"' },
            obj_name: { type: 'string', description: 'Object name (e.g. "ZDE_LEADTIME")' },
            trkorr: { type: 'string', description: 'Transport request number to insert into (must be modifiable)' },
            objectUrl: { type: 'string', description: 'Required only when allowSaveBasedFallback=true: the ADT objectUrl used for lock/unLock' },
            sourceUri: { type: 'string', description: 'Required only when allowSaveBasedFallback=true: the source URI used for getObjectSource/setObjectSource' },
            allowSaveBasedFallback: { type: 'boolean', description: 'When true, if transportReference does not register the object in E071, performs a no-op save (read source, write same source back under the TR). Default false.' },
            system: { type: 'string', description: '"source" (default) or "target"' }
          },
          required: ['pgmid', 'obj_wbtype', 'obj_name', 'trkorr']
        }
      },
      {
        name: 'transportContents',
        description: 'Return the current E071 contents (object list) of a transport request, plus its E070 header. Source of truth for verifying what is in a TR before release.',
        inputSchema: {
          type: 'object',
          properties: {
            trkorr: { type: 'string' },
            system: { type: 'string', description: '"source" (default) or "target"' },
            includeTasks: { type: 'boolean', description: 'When true, also returns rows for child tasks of this TR. Default true.' }
          },
          required: ['trkorr']
        }
      },
      {
        name: 'transportObjectRemove',
        description: 'Remove a single object entry from a modifiable transport request. Probes ADT REST endpoint patterns via the HTTP escape hatch. Reports which pattern succeeded (or that none did, so the user can hand off to Basis).',
        inputSchema: {
          type: 'object',
          properties: {
            pgmid: { type: 'string' },
            obj_wbtype: { type: 'string' },
            obj_name: { type: 'string' },
            trkorr: { type: 'string' },
            system: { type: 'string', description: '"source" (default) or "target"' }
          },
          required: ['pgmid', 'obj_wbtype', 'obj_name', 'trkorr']
        }
      },
      {
        name: 'transportLogs',
        description: 'Return the release/import log rows from E070C plus E070 header for a transport request.',
        inputSchema: {
          type: 'object',
          properties: {
            trkorr: { type: 'string' },
            system: { type: 'string', description: '"source" (default) or "target"' }
          },
          required: ['trkorr']
        }
      },
      {
        name: 'transportObjectKeys',
        description: 'Return E071K rows (sub-key entries) for a transport request. Needed for customizing/append-structure imports that depend on key entries, not just E071 headers.',
        inputSchema: {
          type: 'object',
          properties: {
            trkorr: { type: 'string' },
            system: { type: 'string', description: '"source" (default) or "target"' }
          },
          required: ['trkorr']
        }
      },
      {
        name: 'tadirLookup',
        description: 'Direct TADIR query for an object: returns DEVCLASS (package), responsible, last-change info, and master language. Single call replacement for objectStructure-then-parse.',
        inputSchema: {
          type: 'object',
          properties: {
            pgmid: { type: 'string', description: 'Default "R3TR"' },
            object: { type: 'string', description: 'TADIR object type (e.g. "DTEL")' },
            obj_name: { type: 'string', description: 'Optional. If omitted, returns all rows matching pgmid+object (capped by limit).' },
            limit: { type: 'number', description: 'Max rows (default 100)' },
            system: { type: 'string', description: '"source" (default) or "target"' }
          },
          required: ['object']
        }
      },
      {
        name: 'packageContents',
        description: 'Return every TADIR row in a given package (DEVCLASS). For multi-package scope checks before bundling.',
        inputSchema: {
          type: 'object',
          properties: {
            devclass: { type: 'string', description: 'Package name' },
            limit: { type: 'number', description: 'Max rows (default 500)' },
            system: { type: 'string', description: '"source" (default) or "target"' }
          },
          required: ['devclass']
        }
      },
      {
        name: 'whereUsedDeep',
        description: 'Transitive where-used walk starting from a root object URL. BFS using usageReferences, deduped, with depth and item caps. Useful to confirm the dependency closure before constructing a migration scope. Reminder: this returns "where the object is USED FROM", which is the standard SAP where-used semantic.',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrl: { type: 'string' },
            maxDepth: { type: 'number', description: 'Default 2' },
            maxItems: { type: 'number', description: 'Hard cap on total visited objects. Default 200' },
            system: { type: 'string', description: '"source" (default) or "target"' }
          },
          required: ['objectUrl']
        }
      },
      {
        name: 'adobeFormLayoutProbe',
        description: 'Probe known and candidate ADT REST endpoints for an Adobe Form\'s XDP layout. Returns whatever the server exposes (likely metadata only). Use as Basis hand-off evidence when XDP is not reachable.',
        inputSchema: {
          type: 'object',
          properties: {
            formName: { type: 'string', description: 'Adobe Form name (e.g. "ZAFM_MM_MAU_PR")' },
            system: { type: 'string', description: '"source" (default) or "target"' }
          },
          required: ['formName']
        }
      },
      {
        name: 'transportImport',
        description: 'Trigger an STMS import of a released TR into the target system. NOTE: STMS uses RFC, not ADT REST; this tool currently returns notSupported with the recommended workaround (use importObjectBundle for ADT-creatable types, or hand the TR to Basis for STMS_IMPORT_REQUEST).',
        inputSchema: {
          type: 'object',
          properties: {
            trkorr: { type: 'string' },
            targetSystemId: { type: 'string', description: 'Optional SAP SID of the import target' }
          },
          required: ['trkorr']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'migrationTargetStatus':    return this.handleTargetStatus();
      case 'migrationLoginTarget':     return this.handleTargetLogin();
      case 'migrationLogoutTarget':    return this.handleTargetLogout();
      case 'exportObjectBundle':       return this.handleExportBundle(args);
      case 'importObjectBundle':       return this.handleImportBundle(args);
      case 'probeFormObject':          return this.handleProbeForm(args);
      case 'compareObjectSource':      return this.handleCompareSource(args);
      case 'discoverDependencies':     return this.handleDiscoverDependencies(args);
      case 'createTargetTransport':    return this.handleCreateTargetTransport(args);
      case 'transportInsertObject':    return this.handleTransportInsertObject(args);
      case 'transportContents':        return this.handleTransportContents(args);
      case 'transportObjectRemove':    return this.handleTransportObjectRemove(args);
      case 'transportLogs':            return this.handleTransportLogs(args);
      case 'transportObjectKeys':      return this.handleTransportObjectKeys(args);
      case 'tadirLookup':              return this.handleTadirLookup(args);
      case 'packageContents':          return this.handlePackageContents(args);
      case 'whereUsedDeep':            return this.handleWhereUsedDeep(args);
      case 'adobeFormLayoutProbe':     return this.handleAdobeFormLayoutProbe(args);
      case 'transportImport':          return this.handleTransportImport(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown migration tool: ${toolName}`);
    }
  }

  // ---- system selection -------------------------------------------------

  private async clientFor(system: string | undefined): Promise<ADTClient> {
    if (system === 'target') {
      const t = getTargetClient();
      if (!t.loggedin) await t.login();
      return t;
    }
    return this.adtclient;
  }

  private sqlEsc(s: string): string {
    return String(s).replace(/'/g, "''");
  }

  private wrap(payload: any) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  private async handleTargetStatus(): Promise<any> {
    const status = targetClientStatus();
    let loggedIn = false;
    if (status.configured) {
      try {
        loggedIn = getTargetClient().loggedin;
      } catch {
        loggedIn = false;
      }
    }
    return this.wrap({
      status: 'success',
      configured: status.configured,
      missing: status.missing,
      target: {
        url: status.cfg.url,
        user: status.cfg.user,
        client: status.cfg.client,
        language: status.cfg.language
      },
      loggedIn
    });
  }

  private async handleTargetLogin(): Promise<any> {
    const start = performance.now();
    try {
      const client = getTargetClient();
      const result = await client.login();
      this.trackRequest(start, true);
      return this.wrap({ status: 'success', loggedIn: client.loggedin, result });
    } catch (error: any) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InternalError, `Target login failed: ${error.message || error}`);
    }
  }

  private async handleTargetLogout(): Promise<any> {
    const start = performance.now();
    try {
      try {
        const client = getTargetClient();
        if (client.loggedin) await client.logout();
      } catch {
        // target wasn't configured / never logged in
      }
      resetTargetClient();
      this.trackRequest(start, true);
      return this.wrap({ status: 'success', message: 'Target client closed and cache reset' });
    } catch (error: any) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InternalError, `Target logout failed: ${error.message || error}`);
    }
  }

  private extractPackage(struct: any): string | undefined {
    // ADT exposes the containing package as a link with rel containing "package".
    const links: any[] = struct?.links || [];
    for (const l of links) {
      if (typeof l?.rel === 'string' && l.rel.toLowerCase().includes('package')) {
        const m = /\/packages\/([^/?#]+)/i.exec(l.href || '');
        if (m) return decodeURIComponent(m[1]);
      }
    }
    return undefined;
  }

  private collectSourceUris(struct: any): Array<{ sourceUri: string; includeType?: string }> {
    const out: Array<{ sourceUri: string; includeType?: string }> = [];
    if (Array.isArray(struct?.includes) && struct.includes.length > 0) {
      // Class structure
      for (const inc of struct.includes) {
        const uri = inc?.['abapsource:sourceUri'];
        if (uri) out.push({ sourceUri: uri, includeType: inc?.['class:includeType'] });
      }
    } else {
      const uri = struct?.metaData?.['abapsource:sourceUri'];
      if (uri) out.push({ sourceUri: uri });
    }
    return out;
  }

  private async exportOne(objectUrl: string): Promise<BundleItem> {
    const item: BundleItem = {
      objectUrl,
      name: '',
      type: '',
      structure: undefined,
      sources: [],
      errors: []
    };
    try {
      const struct: any = await this.adtclient.objectStructure(objectUrl);
      item.structure = struct;
      item.name = struct?.metaData?.['adtcore:name'] || '';
      item.type = struct?.metaData?.['adtcore:type'] || '';
      item.description = struct?.metaData?.['adtcore:description'];
      item.responsible = struct?.metaData?.['adtcore:responsible'];
      item.language = struct?.metaData?.['adtcore:masterLanguage'] || struct?.metaData?.['adtcore:language'];
      item.package = this.extractPackage(struct);

      const uris = this.collectSourceUris(struct);
      for (const u of uris) {
        try {
          const source = await this.adtclient.getObjectSource(u.sourceUri);
          item.sources.push({ sourceUri: u.sourceUri, includeType: u.includeType, source });
        } catch (e: any) {
          item.errors.push(`getObjectSource(${u.sourceUri}) failed: ${e.message || e}`);
        }
      }
    } catch (e: any) {
      item.errors.push(`objectStructure failed: ${e.message || e}`);
    }
    return item;
  }

  private async handleExportBundle(args: any): Promise<any> {
    const start = performance.now();
    const urls: string[] = Array.isArray(args?.objectUrls) ? args.objectUrls : [];
    const continueOnError: boolean = args?.continueOnError !== false;
    if (urls.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'objectUrls must be a non-empty array');
    }
    const items: BundleItem[] = [];
    for (const u of urls) {
      const item = await this.exportOne(u);
      items.push(item);
      if (!continueOnError && item.errors.length > 0) {
        this.trackRequest(start, false);
        return this.wrap({
          status: 'partial',
          stoppedAt: u,
          bundle: this.buildBundle(items)
        });
      }
    }
    this.trackRequest(start, true);
    const bundle = this.buildBundle(items);
    return this.wrap({
      status: 'success',
      itemCount: items.length,
      withErrors: items.filter(i => i.errors.length > 0).length,
      bundle
    });
  }

  private buildBundle(items: BundleItem[]): Bundle {
    return {
      generatedAt: new Date().toISOString(),
      sourceSystem: {
        url: this.adtclient.baseUrl,
        user: this.adtclient.username,
        client: this.adtclient.client
      },
      items
    };
  }

  private buildParentPath(targetPackage: string): string {
    return `/sap/bc/adt/packages/${targetPackage}`;
  }

  private async handleImportBundle(args: any): Promise<any> {
    const start = performance.now();
    const bundle: Bundle | undefined = args?.bundle;
    const targetPackage: string | undefined = args?.targetPackage;
    const targetTransport: string | undefined = args?.targetTransport;
    const responsibleOverride: string | undefined = args?.responsible;
    const dryRun: boolean = !!args?.dryRun;

    if (!bundle || !Array.isArray(bundle.items)) {
      throw new McpError(ErrorCode.InvalidParams, 'bundle must include an items array');
    }
    if (!targetPackage) {
      throw new McpError(ErrorCode.InvalidParams, 'targetPackage is required');
    }

    let target: ADTClient;
    try {
      target = getTargetClient();
      if (!target.loggedin) await target.login();
    } catch (e: any) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InternalError, `Target client unavailable: ${e.message || e}`);
    }

    const results: any[] = [];
    const parentPath = this.buildParentPath(targetPackage);

    for (const item of bundle.items) {
      const r: any = { name: item.name, type: item.type, sources: [] };
      try {
        if (!SUPPORTED_IMPORT_TYPES.has(item.type)) {
          r.status = 'skipped';
          r.reason = FORM_TYPES.has(item.type)
            ? `Form types are not creatable via ADT. Hand off ${item.name} (${item.type}) to Basis for transport-based migration.`
            : `Object type ${item.type} is not in the supported import list. Supported: ${[...SUPPORTED_IMPORT_TYPES].join(', ')}`;
          results.push(r);
          continue;
        }
        if (!item.sources || item.sources.length === 0) {
          r.status = 'skipped';
          r.reason = 'Bundle item has no captured source';
          results.push(r);
          continue;
        }

        if (dryRun) {
          r.status = 'dryRun';
          r.wouldCreate = {
            objtype: item.type,
            name: item.name,
            parentName: targetPackage,
            parentPath,
            description: item.description || '',
            responsible: responsibleOverride || item.responsible,
            transport: targetTransport
          };
          r.wouldWriteSources = item.sources.map(s => ({ sourceUri: s.sourceUri, lengthChars: s.source.length, includeType: s.includeType }));
          results.push(r);
          continue;
        }

        await target.createObject({
          objtype: item.type as any,
          name: item.name,
          parentName: targetPackage,
          parentPath,
          description: item.description || '',
          responsible: responsibleOverride || item.responsible,
          transport: targetTransport
        });
        r.created = true;

        for (const src of item.sources) {
          const sr: any = { sourceUri: src.sourceUri, includeType: src.includeType };
          try {
            const lock = await target.lock(item.objectUrl);
            try {
              await target.setObjectSource(src.sourceUri, src.source, lock.LOCK_HANDLE, targetTransport);
              sr.status = 'written';
            } finally {
              try { await target.unLock(item.objectUrl, lock.LOCK_HANDLE); } catch { /* best effort */ }
            }
          } catch (e: any) {
            sr.status = 'failed';
            sr.error = e.message || String(e);
          }
          r.sources.push(sr);
        }

        const anyFailed = r.sources.some((s: any) => s.status !== 'written');
        r.status = anyFailed ? 'partial' : 'created';
      } catch (e: any) {
        r.status = 'failed';
        r.error = e.message || String(e);
      }
      results.push(r);
    }

    const summary = {
      total: results.length,
      created: results.filter(r => r.status === 'created').length,
      partial: results.filter(r => r.status === 'partial').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'failed').length,
      dryRun: results.filter(r => r.status === 'dryRun').length
    };
    this.trackRequest(start, summary.failed === 0);
    return this.wrap({
      status: summary.failed === 0 ? 'success' : 'partial',
      dryRun,
      targetSystem: { url: target.baseUrl, user: target.username, client: target.client },
      targetPackage,
      targetTransport,
      summary,
      results
    });
  }

  private async handleProbeForm(args: any): Promise<any> {
    const start = performance.now();
    const objectUrl: string = args?.objectUrl;
    if (!objectUrl) {
      throw new McpError(ErrorCode.InvalidParams, 'objectUrl is required');
    }
    const audit: any = { objectUrl, exposedByAdt: {}, errors: {}, conclusion: '' };
    try {
      audit.exposedByAdt.structure = await this.adtclient.objectStructure(objectUrl);
    } catch (e: any) { audit.errors.objectStructure = e.message || String(e); }

    try {
      audit.exposedByAdt.path = await this.adtclient.findObjectPath(objectUrl);
    } catch (e: any) { audit.errors.findObjectPath = e.message || String(e); }

    const sourceCandidates: string[] = [];
    const struct = audit.exposedByAdt.structure;
    const directUri = struct?.metaData?.['abapsource:sourceUri'];
    if (directUri) sourceCandidates.push(directUri);
    if (Array.isArray(struct?.includes)) {
      for (const inc of struct.includes) {
        const u = inc?.['abapsource:sourceUri'];
        if (u) sourceCandidates.push(u);
      }
    }
    sourceCandidates.push(`${objectUrl}/source/main`);

    audit.exposedByAdt.sources = [];
    for (const u of [...new Set(sourceCandidates)]) {
      try {
        const source = await this.adtclient.getObjectSource(u);
        audit.exposedByAdt.sources.push({ sourceUri: u, length: source.length, preview: source.slice(0, 200) });
      } catch (e: any) {
        audit.exposedByAdt.sources.push({ sourceUri: u, error: e.message || String(e) });
      }
    }

    const t = struct?.metaData?.['adtcore:type'] || '';
    if (FORM_TYPES.has(t) || /SFPI|SFPF|SSFO|FORM/i.test(t)) {
      audit.conclusion =
        `Form type ${t} cannot be migrated end-to-end via this MCP. The abap-adt-api SDK does not expose form layout (XDP for Adobe Forms, SSF tables for Smart Forms, SAPscript form definition). ` +
        `Use this audit + Basis-assisted transport inclusion (SE03 / TR_OBJECTS_INSERT) to move the form. The exposedByAdt block above shows the full extent of what is reachable.`;
    } else {
      audit.conclusion = `Object type ${t || '(unknown)'} appears to be ADT-managed. Use exportObjectBundle/importObjectBundle for migration.`;
    }
    this.trackRequest(start, true);
    return this.wrap({ status: 'success', audit });
  }

  private async handleCompareSource(args: any): Promise<any> {
    const start = performance.now();
    const objectUrl: string = args?.objectUrl;
    if (!objectUrl) {
      throw new McpError(ErrorCode.InvalidParams, 'objectUrl is required');
    }
    let target: ADTClient;
    try {
      target = getTargetClient();
      if (!target.loggedin) await target.login();
    } catch (e: any) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InternalError, `Target client unavailable: ${e.message || e}`);
    }

    let sourceUri: string | undefined = args?.sourceUri;
    let structure: any = undefined;
    if (!sourceUri) {
      try {
        structure = await this.adtclient.objectStructure(objectUrl);
        sourceUri = structure?.metaData?.['abapsource:sourceUri']
          || (Array.isArray(structure?.includes) && structure.includes[0]?.['abapsource:sourceUri']);
      } catch (e: any) {
        this.trackRequest(start, false);
        throw new McpError(ErrorCode.InternalError, `Could not resolve sourceUri from source system: ${e.message || e}`);
      }
    }
    if (!sourceUri) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InvalidParams, 'No sourceUri available for this object');
    }

    let sourceCode = '', targetCode = '';
    const errors: any = {};
    try { sourceCode = await this.adtclient.getObjectSource(sourceUri); }
    catch (e: any) { errors.source = e.message || String(e); }
    try { targetCode = await target.getObjectSource(sourceUri); }
    catch (e: any) { errors.target = e.message || String(e); }

    const sameContent = !errors.source && !errors.target && sourceCode === targetCode;
    this.trackRequest(start, true);
    return this.wrap({
      status: 'success',
      objectUrl,
      sourceUri,
      sameContent,
      lengths: { source: sourceCode.length, target: targetCode.length },
      lines: { source: sourceCode ? sourceCode.split('\n').length : 0, target: targetCode ? targetCode.split('\n').length : 0 },
      errors,
      sourcePreview: sourceCode.slice(0, 400),
      targetPreview: targetCode.slice(0, 400)
    });
  }

  private async handleDiscoverDependencies(args: any): Promise<any> {
    const start = performance.now();
    const urls: string[] = Array.isArray(args?.objectUrls) ? args.objectUrls : [];
    if (urls.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'objectUrls must be a non-empty array');
    }
    const rows: any[] = [];
    for (const u of urls) {
      const row: any = { objectUrl: u };
      try {
        const s: any = await this.adtclient.objectStructure(u);
        row.name = s?.metaData?.['adtcore:name'];
        row.type = s?.metaData?.['adtcore:type'];
        row.description = s?.metaData?.['adtcore:description'];
        row.package = this.extractPackage(s);
        row.responsible = s?.metaData?.['adtcore:responsible'];
        row.creatableViaAdt = SUPPORTED_IMPORT_TYPES.has(row.type);
        row.isForm = FORM_TYPES.has(row.type) || /SFPI|SFPF|SSFO|FORM/i.test(row.type || '');
      } catch (e: any) {
        row.error = e.message || String(e);
      }
      rows.push(row);
    }
    const packages = [...new Set(rows.map(r => r.package).filter(Boolean))];
    this.trackRequest(start, true);
    return this.wrap({
      status: 'success',
      count: rows.length,
      packages,
      formCount: rows.filter(r => r.isForm).length,
      creatableCount: rows.filter(r => r.creatableViaAdt).length,
      rows
    });
  }

  private async handleCreateTargetTransport(args: any): Promise<any> {
    const start = performance.now();
    const { seedObjectUrl, description, devClass, transportLayer } = args || {};
    if (!seedObjectUrl || !description || !devClass) {
      throw new McpError(ErrorCode.InvalidParams, 'seedObjectUrl, description, and devClass are required');
    }
    let target: ADTClient;
    try {
      target = getTargetClient();
      if (!target.loggedin) await target.login();
    } catch (e: any) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InternalError, `Target client unavailable: ${e.message || e}`);
    }
    try {
      const trkorr = await target.createTransport(seedObjectUrl, description, devClass, transportLayer);
      this.trackRequest(start, true);
      return this.wrap({ status: 'success', trkorr, targetSystem: { url: target.baseUrl, user: target.username, client: target.client } });
    } catch (e: any) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InternalError, `createTransport on target failed: ${e.message || e}`);
    }
  }

  // ---- TR population / inspection --------------------------------------

  private async verifyObjectInTr(client: ADTClient, trkorr: string, obj_name: string): Promise<{ inTr: boolean; rows: any[]; error?: string }> {
    try {
      const sql = `SELECT TRKORR, AS4POS, PGMID, OBJECT, OBJ_NAME FROM E071 WHERE TRKORR = '${this.sqlEsc(trkorr)}' AND OBJ_NAME = '${this.sqlEsc(obj_name)}'`;
      const r: any = await client.runQuery(sql, 50);
      const rows = Array.isArray(r?.values) ? r.values : [];
      return { inTr: rows.length > 0, rows };
    } catch (e: any) {
      return { inTr: false, rows: [], error: e.message || String(e) };
    }
  }

  private async handleTransportInsertObject(args: any): Promise<any> {
    const start = performance.now();
    const { pgmid, obj_wbtype, obj_name, trkorr, objectUrl, sourceUri, allowSaveBasedFallback, system } = args || {};
    if (!pgmid || !obj_wbtype || !obj_name || !trkorr) {
      throw new McpError(ErrorCode.InvalidParams, 'pgmid, obj_wbtype, obj_name, trkorr are required');
    }
    const client = await this.clientFor(system);
    const audit: any = { trkorr, pgmid, obj_wbtype, obj_name, attempts: [] };

    // Attempt 1: transportReference (ADT REST GET with tr_number)
    try {
      const ref = await client.transportReference(pgmid, obj_wbtype, obj_name, trkorr);
      audit.attempts.push({ method: 'transportReference', referenceUrl: ref, ok: true });
    } catch (e: any) {
      audit.attempts.push({ method: 'transportReference', ok: false, error: e.message || String(e) });
    }

    let verify = await this.verifyObjectInTr(client, trkorr, obj_name);
    audit.attempts[audit.attempts.length - 1].verifiedInE071 = verify.inTr;

    // Attempt 2: no-op save fallback (only if user opted in and reference didn't take)
    if (!verify.inTr && allowSaveBasedFallback) {
      if (!objectUrl || !sourceUri) {
        audit.attempts.push({
          method: 'noOpSave',
          ok: false,
          error: 'objectUrl and sourceUri are required to use allowSaveBasedFallback'
        });
      } else {
        const att: any = { method: 'noOpSave' };
        try {
          const original = await client.getObjectSource(sourceUri);
          const lock = await client.lock(objectUrl);
          try {
            await client.setObjectSource(sourceUri, original, lock.LOCK_HANDLE, trkorr);
            att.ok = true;
          } finally {
            try { await client.unLock(objectUrl, lock.LOCK_HANDLE); } catch { /* best effort */ }
          }
        } catch (e: any) {
          att.ok = false;
          att.error = e.message || String(e);
        }
        audit.attempts.push(att);
        verify = await this.verifyObjectInTr(client, trkorr, obj_name);
        att.verifiedInE071 = verify.inTr;
      }
    }

    this.trackRequest(start, verify.inTr);
    return this.wrap({
      status: verify.inTr ? 'inserted' : 'notInserted',
      verifiedInE071: verify.inTr,
      e071Rows: verify.rows,
      verifyError: verify.error,
      audit,
      hint: verify.inTr
        ? undefined
        : (allowSaveBasedFallback
            ? 'Neither transportReference nor no-op save populated E071. Hand off to Basis (SE03 / TR_OBJECTS_INSERT).'
            : 'transportReference did not register the object. Retry with allowSaveBasedFallback=true (and supply objectUrl + sourceUri) to attempt a no-op save, or hand off to Basis.')
    });
  }

  private async handleTransportContents(args: any): Promise<any> {
    const start = performance.now();
    const { trkorr, system, includeTasks = true } = args || {};
    if (!trkorr) throw new McpError(ErrorCode.InvalidParams, 'trkorr is required');
    const client = await this.clientFor(system);
    const tr = this.sqlEsc(trkorr);

    let header: any = null, headerErr: string | undefined;
    let objects: any = null, objectsErr: string | undefined;
    let tasks: any = null, tasksErr: string | undefined;

    try {
      const r: any = await client.runQuery(
        `SELECT TRKORR, TRFUNCTION, TRSTATUS, TARSYSTEM, AS4USER, AS4DATE, AS4TIME, AS4TEXT, CLIENT, KORRDEV FROM E070 WHERE TRKORR = '${tr}'`, 5);
      header = r;
    } catch (e: any) { headerErr = e.message || String(e); }

    try {
      const r: any = await client.runQuery(
        `SELECT TRKORR, AS4POS, PGMID, OBJECT, OBJ_NAME, OBJFUNC, LANG FROM E071 WHERE TRKORR = '${tr}' ORDER BY AS4POS`, 5000);
      objects = r;
    } catch (e: any) { objectsErr = e.message || String(e); }

    if (includeTasks) {
      try {
        const r: any = await client.runQuery(
          `SELECT t.TRKORR, t.TRFUNCTION, t.TRSTATUS, t.AS4USER, t.AS4DATE, t.AS4TEXT FROM E070 AS t WHERE t.STRKORR = '${tr}'`, 200);
        tasks = r;
      } catch (e: any) { tasksErr = e.message || String(e); }
    }

    this.trackRequest(start, !objectsErr);
    return this.wrap({
      status: !objectsErr ? 'success' : 'partial',
      trkorr,
      system: system || 'source',
      header, headerErr,
      objects, objectsErr,
      tasks, tasksErr
    });
  }

  private async handleTransportObjectRemove(args: any): Promise<any> {
    const start = performance.now();
    const { pgmid, obj_wbtype, obj_name, trkorr, system } = args || {};
    if (!pgmid || !obj_wbtype || !obj_name || !trkorr) {
      throw new McpError(ErrorCode.InvalidParams, 'pgmid, obj_wbtype, obj_name, trkorr are required');
    }
    const client = await this.clientFor(system);
    const http = (client as any).httpClient;

    const enc = encodeURIComponent;
    const candidates = [
      `/sap/bc/adt/cts/transportrequests/${trkorr}/objects/${enc(pgmid)}/${enc(obj_wbtype)}/${enc(obj_name)}`,
      `/sap/bc/adt/cts/transportrequests/${trkorr}/object?pgmid=${enc(pgmid)}&obj_wbtype=${enc(obj_wbtype)}&obj_name=${enc(obj_name)}`,
      `/sap/bc/adt/cts/transportrequests/reference?pgmid=${enc(pgmid)}&obj_wbtype=${enc(obj_wbtype)}&obj_name=${enc(obj_name)}&tr_number=${trkorr}`
    ];

    const probes: any[] = [];
    let succeeded = false;
    for (const url of candidates) {
      const probe: any = { url, method: 'DELETE' };
      try {
        const resp: any = await http.request(url, { method: 'DELETE', headers: { Accept: 'application/*' } });
        probe.status = resp?.status;
        probe.statusText = resp?.statusText;
        probe.bodyPreview = String(resp?.body || '').slice(0, 400);
        if (probe.status >= 200 && probe.status < 300) {
          succeeded = true;
          probes.push(probe);
          break;
        }
      } catch (e: any) {
        probe.error = e.message || String(e);
      }
      probes.push(probe);
    }

    let verified = false;
    let verifyError: string | undefined;
    try {
      const v = await this.verifyObjectInTr(client, trkorr, obj_name);
      verified = !v.inTr;
      verifyError = v.error;
    } catch (e: any) { verifyError = e.message || String(e); }

    this.trackRequest(start, succeeded && verified);
    return this.wrap({
      status: succeeded && verified ? 'removed' : 'notRemoved',
      verified,
      verifyError,
      probes,
      hint: succeeded && verified
        ? undefined
        : 'No ADT REST endpoint accepted the DELETE. SAP exposes TR object removal via TR_OBJECTS_REMOVE (RFC). Hand off to Basis.'
    });
  }

  private async handleTransportLogs(args: any): Promise<any> {
    const start = performance.now();
    const { trkorr, system } = args || {};
    if (!trkorr) throw new McpError(ErrorCode.InvalidParams, 'trkorr is required');
    const client = await this.clientFor(system);
    const tr = this.sqlEsc(trkorr);

    let header: any = null, headerErr: string | undefined;
    let logs: any = null, logsErr: string | undefined;

    try {
      const r: any = await client.runQuery(
        `SELECT TRKORR, TRFUNCTION, TRSTATUS, TARSYSTEM, AS4USER, AS4DATE, AS4TIME, AS4TEXT FROM E070 WHERE TRKORR = '${tr}'`, 5);
      header = r;
    } catch (e: any) { headerErr = e.message || String(e); }

    try {
      const r: any = await client.runQuery(
        `SELECT TRKORR, AS4POS, MASSNR, MSGTY, TEXT FROM E070C WHERE TRKORR = '${tr}' ORDER BY AS4POS`, 5000);
      logs = r;
    } catch (e: any) { logsErr = e.message || String(e); }

    this.trackRequest(start, !logsErr);
    return this.wrap({
      status: !logsErr ? 'success' : 'partial',
      trkorr,
      system: system || 'source',
      header, headerErr,
      logs, logsErr,
      hint: logsErr ? 'E070C is the in-DB log table for release. STMS/tp log files on disk are NOT reachable via ADT REST.' : undefined
    });
  }

  private async handleTransportObjectKeys(args: any): Promise<any> {
    const start = performance.now();
    const { trkorr, system } = args || {};
    if (!trkorr) throw new McpError(ErrorCode.InvalidParams, 'trkorr is required');
    const client = await this.clientFor(system);
    const tr = this.sqlEsc(trkorr);
    try {
      const r: any = await client.runQuery(
        `SELECT TRKORR, AS4POS, PGMID, OBJECT, OBJNAME, MASTERTYPE, MASTERNAME, TABKEY, KEYFLAG FROM E071K WHERE TRKORR = '${tr}' ORDER BY AS4POS`, 5000);
      this.trackRequest(start, true);
      return this.wrap({ status: 'success', trkorr, system: system || 'source', keys: r });
    } catch (e: any) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InternalError, `transportObjectKeys failed: ${e.message || e}`);
    }
  }

  private async handleTadirLookup(args: any): Promise<any> {
    const start = performance.now();
    const { pgmid = 'R3TR', object, obj_name, limit = 100, system } = args || {};
    if (!object) throw new McpError(ErrorCode.InvalidParams, 'object is required');
    const client = await this.clientFor(system);
    const where: string[] = [
      `PGMID = '${this.sqlEsc(pgmid)}'`,
      `OBJECT = '${this.sqlEsc(object)}'`
    ];
    if (obj_name) where.push(`OBJ_NAME = '${this.sqlEsc(obj_name)}'`);
    const sql = `SELECT PGMID, OBJECT, OBJ_NAME, DEVCLASS, AUTHOR, MASTERLANG, SRCSYSTEM, CHANGEDBY, SRCDEP FROM TADIR WHERE ${where.join(' AND ')}`;
    try {
      const r: any = await client.runQuery(sql, limit);
      this.trackRequest(start, true);
      return this.wrap({ status: 'success', system: system || 'source', query: sql, result: r });
    } catch (e: any) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InternalError, `tadirLookup failed: ${e.message || e}`);
    }
  }

  private async handlePackageContents(args: any): Promise<any> {
    const start = performance.now();
    const { devclass, limit = 500, system } = args || {};
    if (!devclass) throw new McpError(ErrorCode.InvalidParams, 'devclass is required');
    const client = await this.clientFor(system);
    const sql = `SELECT PGMID, OBJECT, OBJ_NAME, DEVCLASS, AUTHOR, MASTERLANG FROM TADIR WHERE DEVCLASS = '${this.sqlEsc(devclass)}' ORDER BY OBJECT, OBJ_NAME`;
    try {
      const r: any = await client.runQuery(sql, limit);
      this.trackRequest(start, true);
      const rows: any[] = Array.isArray(r?.values) ? r.values : [];
      const byType: Record<string, number> = {};
      for (const row of rows) {
        const t = row?.OBJECT || row?.['OBJECT'] || '(unknown)';
        byType[t] = (byType[t] || 0) + 1;
      }
      return this.wrap({ status: 'success', system: system || 'source', devclass, count: rows.length, byType, result: r });
    } catch (e: any) {
      this.trackRequest(start, false);
      throw new McpError(ErrorCode.InternalError, `packageContents failed: ${e.message || e}`);
    }
  }

  private async handleWhereUsedDeep(args: any): Promise<any> {
    const start = performance.now();
    const { objectUrl, maxDepth = 2, maxItems = 200, system } = args || {};
    if (!objectUrl) throw new McpError(ErrorCode.InvalidParams, 'objectUrl is required');
    const client = await this.clientFor(system);

    const seen = new Map<string, { depth: number; ref: any }>();
    const queue: Array<{ url: string; depth: number; parent?: string }> = [{ url: objectUrl, depth: 0 }];
    const errors: any[] = [];

    while (queue.length > 0 && seen.size < maxItems) {
      const cur = queue.shift()!;
      if (seen.has(cur.url)) continue;
      seen.set(cur.url, { depth: cur.depth, ref: { uri: cur.url } });
      if (cur.depth >= maxDepth) continue;
      try {
        const refs: any[] = await client.usageReferences(cur.url) as any;
        for (const r of refs || []) {
          const childUrl = r?.uri;
          if (!childUrl || seen.has(childUrl)) continue;
          const existing = seen.get(childUrl);
          if (existing) {
            existing.ref = r;
          } else {
            seen.set(childUrl, { depth: cur.depth + 1, ref: r });
          }
          queue.push({ url: childUrl, depth: cur.depth + 1, parent: cur.url });
          if (seen.size >= maxItems) break;
        }
      } catch (e: any) {
        errors.push({ url: cur.url, error: e.message || String(e) });
      }
    }

    const items = [...seen.entries()].map(([url, v]) => ({
      url,
      depth: v.depth,
      name: v.ref?.['adtcore:name'],
      type: v.ref?.['adtcore:type'],
      description: v.ref?.['adtcore:description'],
      package: v.ref?.packageRef?.['adtcore:name']
    }));
    this.trackRequest(start, true);
    return this.wrap({
      status: 'success',
      root: objectUrl,
      maxDepth,
      maxItems,
      visited: items.length,
      truncated: seen.size >= maxItems,
      errors,
      items
    });
  }

  private async handleAdobeFormLayoutProbe(args: any): Promise<any> {
    const start = performance.now();
    const { formName, system } = args || {};
    if (!formName) throw new McpError(ErrorCode.InvalidParams, 'formName is required');
    const client = await this.clientFor(system);
    const http = (client as any).httpClient;
    const enc = encodeURIComponent(formName);

    const candidates = [
      { url: `/sap/bc/adt/forms/printforms/${enc}`, accept: 'application/vnd.sap.adt.printform.v1+xml' },
      { url: `/sap/bc/adt/forms/printforms/${enc}/source/main`, accept: '*/*' },
      { url: `/sap/bc/adt/forms/printforminterfaces/${enc}`, accept: 'application/vnd.sap.adt.printforminterface.v1+xml' },
      { url: `/sap/bc/adt/sfpf/${enc}`, accept: '*/*' },
      { url: `/sap/bc/adt/sfpf/${enc}/source/main`, accept: '*/*' },
      { url: `/sap/bc/adt/sfpf/${enc}/layout`, accept: 'application/xml' },
      { url: `/sap/bc/adt/sfpf/${enc}/xdp`, accept: 'application/xml' },
      { url: `/sap/bc/adt/repository/informationsystem/objectproperties/values?uri=${encodeURIComponent('/sap/bc/adt/sfpf/' + formName)}`, accept: 'application/xml' }
    ];

    const results: any[] = [];
    for (const c of candidates) {
      const r: any = { url: c.url, accept: c.accept };
      try {
        const resp: any = await http.request(c.url, { headers: { Accept: c.accept } });
        r.status = resp?.status;
        r.statusText = resp?.statusText;
        r.contentType = resp?.headers?.['content-type'];
        r.bodyLength = String(resp?.body || '').length;
        r.bodyPreview = String(resp?.body || '').slice(0, 400);
        const ct = String(r.contentType || '');
        const body = String(resp?.body || '');
        r.looksLikeXdp = /<xdp\b|<template\b[^>]*xfa|xfa\.adobe\.com/.test(body);
        r.looksLikeXml = ct.includes('xml') || /^\s*<\?xml/.test(body);
      } catch (e: any) {
        r.error = e.message || String(e);
      }
      results.push(r);
    }

    const xdpHit = results.find(r => r.looksLikeXdp);
    this.trackRequest(start, true);
    return this.wrap({
      status: 'success',
      formName,
      system: system || 'source',
      xdpReachable: !!xdpHit,
      xdpEndpoint: xdpHit?.url,
      probes: results,
      conclusion: xdpHit
        ? `XDP layout appears reachable at ${xdpHit.url}. Capture this URL and consider building adobeFormLayoutWrite next.`
        : `No probed endpoint returned an XDP/XFA payload. The Adobe Form layout for ${formName} is not retrievable via ADT REST on this system. Hand off to Basis for transport-based migration.`
    });
  }

  private async handleTransportImport(args: any): Promise<any> {
    const { trkorr, targetSystemId } = args || {};
    if (!trkorr) throw new McpError(ErrorCode.InvalidParams, 'trkorr is required');
    return this.wrap({
      status: 'notSupported',
      trkorr,
      targetSystemId,
      reason: 'STMS import (tp / STMS_IMPORT_REQUEST) is invoked via RFC, not via ADT REST. The abap-adt-api SDK exposes only the ADT REST surface and cannot trigger an STMS import.',
      workarounds: [
        'For ADT-creatable types (DTEL/TABL/CLAS/INTF/PROG/MSAG/DDLS/DCLS/DDLX): use importObjectBundle to recreate objects directly on the target system. This bypasses STMS entirely.',
        'For form types (Adobe/Smart/SAPscript) and other non-ADT-creatable types: hand the released TR to Basis to run STMS_IMPORT_REQUEST or the STMS GUI on the target system.',
        'If your SAP setup exposes an HTTP gateway to STMS (some SolMan/CloudALM setups do), call that gateway directly with httpClient — but no such endpoint is part of standard ADT.'
      ]
    });
  }
}
