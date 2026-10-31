/** Disclosed CoThink compatibility API, not an upstream pi-subagents API. */
export interface HostLaunchInput {
  cwd: string;
  parentSessionId?: string;
  model?: string;
  runId?: string;
  childAgentName?: string;
  childIndex?: number;
  /** Original native placement, resolved by pi-subagents; metadata grants no authority. */
  machine?: unknown;
  /** Host-returned lease identity for the later authenticated remote transport adapter. */
  hostRemoteLease?: { leaseId: string; ownerEpoch: string; workspaceId: string; placementDigest: string };
  [field: string]: unknown;
}
export interface HostIntegration {
  agentDir?:string;
  /** Synchronous frozen-profile lookup before native project settings, SSH or staging. */
  resolvePlacement?(input:{machine:string;requestedCwd?:string;parentSessionId:string;operationId?:string}):{machine:{provider:"herdr";[key:string]:unknown};connection:{sshConfig:string}};
  /** Synchronous check immediately before native output inspection or writes. */
  validateOutput?(input:{output:string;parentSessionId:string}):void;
  /** Persist before returning. Reject before native operation writers run. */
  admitOperation(input: HostLaunchInput & { operationId: string }): Promise<Partial<HostLaunchInput>>;
  /** Persist before returning. Provide an independent, scoped copy and launch ID. */
  admitChild(input: HostLaunchInput & { requestId: string }): Promise<HostLaunchInput & { launchId: string }>;
  /** Native detached process must be registered before config/status writes or spawn. */
  admitRunner?(input: HostLaunchInput & {runnerProcessInstanceId:string;hostOperationId:string}):Promise<Record<string,unknown>>;
  runnerSpawned?(input:{runnerProcessInstanceId:string;process:import('node:child_process').ChildProcess}):void|Promise<void>;
  prepareResume?(input:{target:Record<string,unknown>;operationId:string;parentSessionId:string}):Promise<Record<string,unknown>>;
  operationReturned?(input:{operationId:string}):Promise<void>;
  sourceOutput?<T>(input:{output:string;parentSessionId:string;operationId:string},operation:()=>T|Promise<T>):Promise<T>;
  prepareRemote?(input:{launchId:string;toolNames?:string[];excludedTools?:string[]}):Promise<{args:string[];resources:Record<string,unknown>;environment:Record<string,string>}>;
  stopRemote?(input:{launchId:string}):Promise<{disposed:boolean;shutdownCompleted:boolean;timedOut:boolean;errors:string[]}>;
  claimStart?(facts: { launchId: string }): Promise<void>;
  started(facts: { launchId: string; sessionId: string; sessionFile?: string; model?: string | null; api?:string; baseUrl?:string; thinking?:string; remoteIdentity?:Record<string,unknown>; control?:{abort():Promise<void>} }): Promise<void>;
  terminal(facts: { launchId: string; sessionId: string; disposed: boolean; shutdownCompleted: boolean; timedOut: boolean; errors: string[]; remoteIdentity?:Record<string,unknown> }): Promise<void>;
  closed?(): Promise<void>;
  finished?(facts:{launchId:string;sdkTerminalObserved:boolean;result:Record<string,unknown>}):Promise<void>;
}
export declare function registerHostIntegration(input: { cwd: string; parentSessionId: string; host: HostIntegration }): () => Promise<void>;
export declare function admitHostOperation(input: HostLaunchInput): Promise<HostLaunchInput>;
export declare function admitHostChild(input: HostLaunchInput): Promise<HostLaunchInput>;
export declare function verifyHostInput(input: HostLaunchInput): void;
export declare function verifyHostChild(input: HostLaunchInput): void;
export declare function claimHostChild(input: HostLaunchInput): Promise<void>;
export declare function hostChildStarted(input: HostLaunchInput, facts: { sessionId: string; sessionFile?: string; model?: string | null }): Promise<void>;
export declare function hostChildTerminal(input: HostLaunchInput, facts: { sessionId: string; disposed: boolean; shutdownCompleted: boolean; timedOut: boolean; errors: string[]; remoteIdentity?:Record<string,unknown> }): Promise<void>;
export declare function bindHostResult(result:object,input:HostLaunchInput):void;
export declare function finishHostResult(result:object):Promise<void>;
export declare function withHostOperation<T>(input:HostLaunchInput,callback:(admitted:HostLaunchInput)=>T|Promise<T>):Promise<T>;
export declare function withHostResources<T>(agentDir:string,callback:()=>T,options?:{headlessUI?:boolean}):T;
export declare function hostAgentDirectory():string|undefined;
export declare function headlessHostUI():boolean;
export declare function headlessHostAPI<T extends object>(pi:T):T;
export declare function executeHostCommand(input:HostLaunchInput):Promise<unknown>;
export declare function validateHostOutput(output:string|undefined):void;

export declare function hostOperationContext<T extends object>(ctx:T,admitted:HostLaunchInput):T;
export declare function admitHostRunner(config:HostLaunchInput,parentSessionId:string):Promise<HostLaunchInput>;
export declare function hostRunnerSpawned(config:HostLaunchInput,process:import('node:child_process').ChildProcess):void;
export declare function withRunnerOperation<T>(input:{cwd:string;parentSessionId:string;operationId:string},callback:()=>T|Promise<T>):Promise<T>;

export declare function admitHostResume<T extends object>(target:T):Promise<T>;

export declare function hostRunnerReady(config:HostLaunchInput):Promise<void>;

export declare function withHostSourceOutput<T>(output:string|undefined,operation:()=>T|Promise<T>):Promise<T>;

export declare function resolveHostMachinePlacement(input:{cwd:string;machine:string;stepCwd?:string}):{machine:Record<string,unknown>}|undefined;
export declare function hostMachineConnection(machine:object):{sshConfig?:string};
export declare function openHostRemoteAccess(machine:object):Promise<{shellCommand(script:string,args?:string[]):string;runAsync(command:string,limits?:Record<string,unknown>):Promise<{status:number|null;stdout:string;stderr:string;error?:Error}>}>;
export declare function prepareHostRemote(input:HostLaunchInput):Promise<{args:string[];resources:Record<string,unknown>;environment:Record<string,string>}|undefined>;
export declare function stopHostRemote(input:HostLaunchInput):Promise<Record<string,unknown>|undefined>;
export declare function resolveRegisteredHerdrProfile(input:{selector:string;cwd:string;herdrBin:string;env:Record<string,string>}):Promise<Record<string,unknown>>;
export declare function remapHostMachine(machine:object,cwd:string):Record<string,unknown>;
