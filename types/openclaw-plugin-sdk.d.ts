// Ambient stub for the `openclaw/plugin-sdk` module.
// graph-memory-pro imports types from this module at compile-time, but the
// real implementation is supplied by the OpenClaw host at runtime. This stub
// provides the minimal type surface we actually use so that `tsc --noEmit`
// passes in CI without depending on the openclaw npm package being installed.
// Keep the real openclaw package in peerDependencies for runtime resolution.

declare module "openclaw/plugin-sdk" {
  import type { IncomingMessage, ServerResponse } from "http";

  export interface OpenClawPluginHttpRouteHandler {
    (req: IncomingMessage, res: ServerResponse):
      | Promise<boolean | void>
      | boolean
      | void;
  }

  export interface OpenClawPluginHttpRouteParams {
    path: string;
    handler: OpenClawPluginHttpRouteHandler;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
  }

  /** Minimal commander-compatible surface; the real instance is injected by host. */
  export interface OpenClawPluginCliCommand {
    command(name: string): OpenClawPluginCliCommand;
    description(text: string): OpenClawPluginCliCommand;
    option(flags: string, description?: string, defaultValue?: unknown): OpenClawPluginCliCommand;
    action(handler: (options: Record<string, unknown>) => void | Promise<void>): OpenClawPluginCliCommand;
  }

  export interface OpenClawPluginCliContext {
    program: OpenClawPluginCliCommand;
    parentPath: readonly string[];
    config: any;
    workspaceDir?: string;
    logger: OpenClawPluginLogger;
  }

  export type OpenClawPluginCliRegistrar = (ctx: OpenClawPluginCliContext) => void | Promise<void>;

  export interface OpenClawPluginCliRegistrationOptions {
    parentPath?: readonly string[];
    commands?: readonly string[];
  }

  export interface OpenClawPluginLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  }

  export interface OpenClawPluginApi {
    logger: OpenClawPluginLogger;
    config: any;
    pluginConfig: unknown;
    resolvePath(path: string): string;
    on(event: string, handler: (...args: any[]) => any): void;
    registerContextEngine(id: string, factory: (...args: any[]) => any): void;
    registerTool(...args: any[]): void;
    registerHttpRoute(params: OpenClawPluginHttpRouteParams): void;
    registerCli?(
      registrar: OpenClawPluginCliRegistrar,
      opts?: OpenClawPluginCliRegistrationOptions,
    ): void;
    [key: string]: any;
  }
}
