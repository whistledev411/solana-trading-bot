import { env } from 'process';
import { EventEmitter } from 'events';
import { hostname } from 'os';
import { Etcd3, Lease, ILeaseKeepAliveResponse, IWatchResponse, IKeyValue, IOptions, Watcher } from 'etcd3';
import { transform } from 'lodash';

import { LogProvider } from '@core/providers/LogProvider';
import { 
  ElectionEvent, ElectionListener, WatchEvent, WatchListener,
  InitWatchOpts, CreateLeaseOptions, GetAllResponse,
  ELECTION_EVENTS, WATCH_EVENTS, ELECTION_ERROR_TIMEOUT_IN_MS
} from '@core/types/Etcd';
import { EtcdSchema, ValueSerializer } from '@core/models/EtcdModel';


const HOSTNAME = hostname();

export class ETCDProvider extends EventEmitter {
  private client: Etcd3;
  private zLog: LogProvider = new LogProvider(ETCDProvider.name);

  constructor(private hostname = HOSTNAME, private opts = DEFAULT_OPTS) { 
    super();
    this.client = new Etcd3(this.opts);
  }

  onElection = (event: ElectionEvent, listener: ElectionListener) => super.on(event, listener);

  onWatch<T extends WatchEvent>(event: T, listener: WatchListener<T>) {
    return super.on(event, listener);
  }

  async startElection(electionName: string) {
    const election = this.client.election(electionName);

    const createCampaign = () => {
      const campaign = election.campaign(this.hostname);
      this.zLog.info(`campaign started for host: ${this.hostname}`);

      campaign.on('elected', () => {
        this.zLog.info('I am the new leader');
        this.emitElectionEvent(ELECTION_EVENTS.elected, true);
      });

      campaign.on('error', err => {
        this.zLog.error(`campaign error: ${err.message}`);
        setTimeout(() => createCampaign(), ELECTION_ERROR_TIMEOUT_IN_MS);
      });
    };

    const createObserver = async () => {
      const observer = await election.observe();
      this.zLog.info('leader observer started');

      observer.on('change', leader => {
        if (leader !== this.hostname) { 
          this.zLog.info(`the new leader is: ${leader}`);
          this.emitElectionEvent(ELECTION_EVENTS.elected, false);
        }
      });

      observer.on('error', err => {
        this.zLog.error(`observer error: ${err.message}`);
        setTimeout(() => createObserver, ELECTION_ERROR_TIMEOUT_IN_MS);
      });
    };

    createCampaign();
    createObserver();
  }

  async startWatcher<T extends 'key' | 'prefix', K extends string = undefined, PRF extends string = undefined>(
    opts: InitWatchOpts<T, K, PRF>
  ): Promise<Watcher> {
    const watcher = await (async (): Promise<Watcher> => {
      if ('prefix' in opts) return this.client.watch().prefix(opts.prefix).create();
      return this.client.watch().key(opts.key).create();
    })();

    watcher.on('connected', () => this.zLog.info('watcher successfully connected'));
    watcher.on('disconnected', () => this.zLog.info('watcher disconnected'));
    watcher.on('error', err => this.zLog.error(`error on watcher: ${err.message}`));

    watcher.on('data', data => this.emitMutatedKeyEvent(WATCH_EVENTS.data, data));
    watcher.on('delete', res => this.emitMutatedKeyEvent(WATCH_EVENTS.delete, res));
    watcher.on('put', res => this.emitMutatedKeyEvent(WATCH_EVENTS.put, res));

    return watcher;
  }

  async startWatcherForLease<T extends string>(watchOpts: InitWatchOpts<'key', T>, leaseOpts: CreateLeaseOptions): Promise<Watcher> {
    await this.createLease(watchOpts.key, leaseOpts);
    return this.startWatcher<'key', T>(watchOpts);
  }

  async put<T extends string, V, PRF extends string = undefined>(
    key: (EtcdSchema<T, V, PRF>)['formattedKeyType'], value: (EtcdSchema<T, V, PRF>)['parsedValueType']
  ): Promise<boolean> {
    await this.client.put(key).value(Buffer.from(JSON.stringify(value)));
    return true;
  }

  async get<T extends string, V, PRF extends string = undefined>(
    key: (EtcdSchema<T, V, PRF>)['formattedKeyType']
  ): Promise<(EtcdSchema<T, V, PRF>)['parsedValueType']> {
    const buff = await this.client.get(key).buffer();
    return ValueSerializer.deserialize(buff);
  }

  async delete<T extends string, V, PRF extends string = undefined>(
    key: (EtcdSchema<T, V, PRF>)['formattedKeyType']
  ): Promise<boolean> {
    await this.client.delete().key(key);
    return true;
  }

  async getAllForPrefix<T extends string, V, PRF extends string = undefined>(
    prefix: (EtcdSchema<T, V, PRF>)['prefix']
  ): Promise<GetAllResponse<T, V, PRF>> {
    const resp: { [key: string]: Buffer } = await this.client.getAll().prefix(prefix).buffers();
    return transform(resp, (acc, curr, key) => acc[key] = ValueSerializer.deserialize(curr), {} as GetAllResponse<T, V, PRF>);
  }

  async createLease<T extends string, V, PRF extends string = undefined>(
    existingKey: (EtcdSchema<T, V, PRF>)['formattedKeyType'], opts: CreateLeaseOptions
  ): Promise<Lease> {
    const lease = this.client.lease(opts.ttl, opts.opts);
    await lease.put(existingKey).exec();
    return lease;
  }

  async renewLeaseOnce(lease: Lease): Promise<ILeaseKeepAliveResponse> {
    return lease.keepaliveOnce();
  }

  async revokeLease(lease: Lease): Promise<boolean> {
    await lease.revoke();
    return true;
  }

  private emitElectionEvent = (event: ElectionEvent, elected: boolean) => super.emit(event, elected);
  private emitMutatedKeyEvent = (event: WatchEvent, data: IWatchResponse | IKeyValue) => super.emit(event, data);
}


export const DEFAULT_OPTS: IOptions = (() => {
  const hosts: string[] = ((): string[] => {
    const listAsString = env.ETCDHOSTS;
    return listAsString?.split(',') ?? null;
  })();

  return { hosts };
})();