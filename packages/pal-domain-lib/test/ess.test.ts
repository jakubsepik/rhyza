/**
 * Unit testy pre pal-domain-lib - doplnenie pokrytia mimo wallet-address issue.
 *
 * Testované časti:
 *  - assets .......... aktivácia meny po priradení ledger účtu
 *  - forex ........... plánovanie expirácie FX kurzov a ich obnova z ASE
 *  - liquidity ....... čistenie in-memory ledgeru a serializácia transakcií
 *
 * Použité test doubles:
 *  - MockAssetRepo / MockFxRepo / MockLedgerEventSourcingRepository /
 *    MockMessageProducer / MockTelemetryService = fake (in-memory náhrady)
 *  - StubAseFxService / StubFxCacheExpiryService = stub (pevné odpovede)
 *  - RecordingLogger = spy (zachytáva warning/error hlášky)
 *  - stub console.log v teste čistenia ledgeru
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { IMessage, NullLogger } from 'common-types-lib';
import {
    AssetActivatedEvent,
    FxRateCacheExpiredEvent
} from 'pal-public-types-lib';
import {
    AssetAggregate,
    AssetNotFoundError,
    CreateLedgerCmd,
    FxAggregate,
    FxCacheExpiryService,
    FxRate,
    ILedgerTransaction,
    IPalAseFxService,
    IPalFxCacheExpiryService,
    LedgerAggregate,
    LedgerTransactionDtoSerializer
} from '../src';
import {
    MockAssetRepo,
    MockFxRepo,
    MockLedgerEventSourcingRepository,
    MockMessageProducer,
    MockTelemetryService
} from './mocks';

// FxCacheExpiryService odpočítava 5 s od reálnej expirácie (clock drift,
// latencia Kafky), preto test počíta expiráciu ako "teraz + 5 s + delay".
const TTL_REDUCED_BY_MS = 5000;

// Rezerva, aby časovač na 200 ms stihol vystreliť aj na pomalom CI.
const EXPIRY_EVENT_WAIT_MS = 500;

const PEER_ID = 'peer-1';

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spy logger: namiesto reálneho loggera si pamätá warningy a errory,
 * aby ich test mohol skontrolovať. Je to test double typu "spy".
 */
class RecordingLogger extends NullLogger {
    readonly warnings: string[] = [];
    readonly errors: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override warn(...args: any[]): void {
        this.warnings.push(args.map((arg) => String(arg)).join(' '));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override error(...args: any[]): void {
        this.errors.push(args.map((arg) => String(arg)).join(' '));
    }
}

/**
 * Stub externej ASE služby (poskytuje FX kurzy).
 * - nikdy nevolá sieť,
 * - zaznamenáva, s akými parametrami bola zavolaná,
 * - vie simulovať výpadok cez `fail`.
 */
class StubAseFxService implements IPalAseFxService {
    readonly peerCalls: [string, string, string][] = [];
    readonly intraCalls: [string, string][] = [];

    constructor(
        private readonly rate: number = 1.75,
        private readonly fail: boolean = false
    ) { }

    async getPeerFxFromAse(
        sourceAssetCode: string,
        destinationAssetCode: string,
        peerId: string
    ): Promise<{ rate: number; expiresAt: number }> {
        this.peerCalls.push([sourceAssetCode, destinationAssetCode, peerId]);

        if (this.fail) {
            throw new Error('ASE is unavailable');
        }

        return { rate: this.rate, expiresAt: Date.now() + 60_000 };
    }

    async getIntraAseFxRate(
        sourceAssetCode: string,
        destinationAssetCode: string
    ): Promise<{ rate: number; expiresAt: number }> {
        this.intraCalls.push([sourceAssetCode, destinationAssetCode]);

        if (this.fail) {
            throw new Error('ASE is unavailable');
        }

        return { rate: this.rate, expiresAt: Date.now() + 60_000 };
    }
}

/**
 * Stub služby expirácie: namiesto reálnych časovačov len zaznamená,
 * že aggregate chcel nastaviť/zrušiť expiráciu. Časovače testujeme
 * samostatne v teste č. 2.
 */
class StubFxCacheExpiryService implements IPalFxCacheExpiryService {
    readonly setExpiryCalls: { rateId: string; expiresAt: number }[] = [];
    readonly clearedRateIds: string[] = [];

    async setExpiry(rateId: string, expiresAt: number): Promise<void> {
        this.setExpiryCalls.push({ rateId, expiresAt });
    }

    async clearExpiry(rateId: string): Promise<void> {
        this.clearedRateIds.push(rateId);
    }
}

/**
 * TEST 1 - ASSET: aktivácia meny po priradení ledger účtu.
 *
 * Mena (napr. EUR) musí pred použitím prejsť dvoma krokmi:
 *   1. vytvorenie (createAsset),
 *   2. priradenie ledger účtu (associateLedgerAccountAndActivate).
 * Druhý krok ju aktivuje a musí vygenerovať AssetActivatedEvent, ktorý
 * čítajú ostatné služby.
 *
 * Overuje:
 *  - ledgerAccountId sa naozaj uloží,
 *  - vznikne práve 1 event typu AssetActivatedEvent so správnym payloadom,
 *  - aktivácia neexistujúcej meny vyhodí AssetNotFoundError.
 *
 * Test double: MockAssetRepo = fake repozitár namiesto reálnej DB.
 */
test('PAL Asset Domain - ledger account association activates the asset', async () => {
    const aggregate = new AssetAggregate(new MockAssetRepo(), new NullLogger());

    // 1. krok: vytvor menu "eur" s 2 desatinnými miestami.
    await aggregate.createAsset('eur', 2);

    // Eventy z createAsset nás teraz nezaujímajú, chceme vidieť len aktiváciu.
    aggregate.clearUncommittedDomainEvents();

    // 2. krok: priraď ledger účet a aktivuj menu.
    await aggregate.associateLedgerAccountAndActivate('eur', 'ledger-account-1');

    const [asset] = await aggregate.getAssets(['EUR']);
    assert.ok(asset);
    assert.equal(asset.ledgerAccountId, 'ledger-account-1');

    // Po aktivácii musí vzniknúť práve jeden event.
    assert.equal(aggregate.uncommittedDomainEvents.length, 1);

    const [event] = aggregate.uncommittedDomainEvents;
    assert.equal(event.msgName, AssetActivatedEvent.name);
    assert.deepEqual(event.payload, { assetCode: 'EUR' });

    // Neexistujúca mena sa nesmie ticho "aktivovať".
    const emptyAggregate = new AssetAggregate(
        new MockAssetRepo(),
        new NullLogger()
    );
    await assert.rejects(
        () =>
            emptyAggregate.associateLedgerAccountAndActivate(
                'usd',
                'ledger-account-1'
            ),
        AssetNotFoundError
    );
});

/**
 * TEST 2 - FX CACHE: publikovanie expirácie a nahradenie časovača.
 *
 * Kurz z ASE má `expiresAt`. PAL si naň naplánuje setTimeout a po vypršaní
 * pošle FxRateCacheExpiredEvent. Keď pre rovnaký kurz príde novší údaj,
 * starý časovač sa musí zrušiť - inak by neskôr poslal duplicitnú udalosť
 * a zbytočne by sa obnovoval už obnovený kurz.
 *
 * Časovanie zámerne: starý časovač ~40 ms, nový ~200 ms.
 *  - správna implementácia: starý sa zruší, do 500 ms príde 1 správa,
 *  - keby sa starý nezrušil: prídu 2 správy a test padne.
 *
 * Test doubles: MockMessageProducer = fake namiesto Kafky,
 * NullLogger = tichý logger.
 */
test('PAL Forex Domain - FxCacheExpiryService publishes expiry event and replaces timer', async () => {
    const messages: IMessage[] = [];
    const service = new FxCacheExpiryService(
        new MockMessageProducer(messages),
        new NullLogger()
    );

    try {
        // Starý kurz pre USD/EUR: vyprší o ~40 ms.
        await service.setExpiry('USD/EUR', Date.now() + TTL_REDUCED_BY_MS + 40);

        // Prišiel novší kurz pre ten istý rateId: starý časovač sa musí zrušiť
        // a nahradiť časovačom, ktorý vyprší o ~200 ms.
        await service.setExpiry('USD/EUR', Date.now() + TTL_REDUCED_BY_MS + 200);

        await sleep(EXPIRY_EVENT_WAIT_MS);

        // Keby starý časovač nebol zrušený, boli by tu 2 správy.
        assert.equal(messages.length, 1);
        assert.equal(messages[0].msgName, FxRateCacheExpiredEvent.name);
        assert.deepEqual(messages[0].payload, { id: 'USD/EUR' });
    } finally {
        // Upratať časovače aj pri zlyhanom asserte, aby test proces nezablokoval.
        service.destroy();
    }
});

/**
 * TEST 3 - FX CACHE: clearExpiry zruší naplánovanú udalosť.
 *
 * Používa sa, keď ASE pošle nový kurz skôr, než starý vyprší.
 * clearExpiry musí byť idempotentné - druhé volanie pre ten istý rateId
 * nesmie spadnúť, len nesmie nájsť žiadny časovač.
 *
 * Overuje: po zrušení už nepríde žiadna FxRateCacheExpiredEvent.
 *
 * Test double: MockMessageProducer = fake namiesto Kafky.
 */
test('PAL Forex Domain - FxCacheExpiryService clearExpiry cancels pending event', async () => {
    const messages: IMessage[] = [];
    const service = new FxCacheExpiryService(
        new MockMessageProducer(messages),
        new NullLogger()
    );

    try {
        // Naplánuj udalosť na ~40 ms.
        await service.setExpiry('USD/EUR', Date.now() + TTL_REDUCED_BY_MS + 40);

        // Zruš ju a druhé volanie overí vetvu "časovač už neexistuje".
        await service.clearExpiry('USD/EUR');
        await service.clearExpiry('USD/EUR');

        await sleep(EXPIRY_EVENT_WAIT_MS);

        assert.equal(messages.length, 0);
    } finally {
        service.destroy();
    }
});

/**
 * TEST 4 - FX: obnovenie expirovaných kurzov stiahnutých z ASE.
 *
 * notifyExpiredFxRate reaguje na FxRateCacheExpiredEvent. Ak bol kurz
 * stiahnutý PAL-om (PulledFromAse) a bol načítaný pred časom oznámenia,
 * znovu sa stiahne z ASE, uloží sa nová hodnota a nastaví sa nová
 * expirácia. Test overuje peer kurz (PeerRate) aj intra-ASE kurz.
 *
 * Test doubles:
 *  - MockFxRepo = fake repozitár,
 *  - StubAseFxService = stub s pevnou hodnotou 1.75,
 *  - StubFxCacheExpiryService = stub, ktorý len zaznamená setExpiry.
 */
test('PAL Forex Domain - notifyExpiredFxRate refreshes pulled peer and intra rates', async () => {
    const rateRepo = new MockFxRepo();
    const aseService = new StubAseFxService(1.75);
    const cacheExpiry = new StubFxCacheExpiryService();
    const aggregate = new FxAggregate(
        rateRepo,
        aseService,
        cacheExpiry,
        new NullLogger()
    );

    // Dva staré, už expirované kurzy: peer a intra-ASE.
    const stalePeerRate = new FxRate(
        'USD',
        'EUR',
        'PeerRate',
        'PulledFromAse',
        PEER_ID,
        1.1,
        1000,
        Date.now() - 1
    );
    const staleIntraRate = new FxRate(
        'USD',
        'GBP',
        'IntraAseRate',
        'PulledFromAse',
        null,
        0.9,
        1000,
        Date.now() - 1
    );
    await rateRepo.store(stalePeerRate.toDto());
    await rateRepo.store(staleIntraRate.toDto());

    // 2000 > fetchedAt 1000, takže obnova má prebehnúť.
    await aggregate.notifyExpiredFxRate(stalePeerRate.id, 2000);
    await aggregate.notifyExpiredFxRate(staleIntraRate.id, 2000);

    // ASE musí dostať presne správny peer a menové páry.
    assert.deepEqual(aseService.peerCalls, [['USD', 'EUR', PEER_ID]]);
    assert.deepEqual(aseService.intraCalls, [['USD', 'GBP']]);

    // Pre oba kurzy sa musí nastaviť nová expirácia.
    assert.equal(cacheExpiry.setExpiryCalls.length, 2);

    // Nová hodnota musí byť uložená v repozitári.
    const [refreshedPeerRate] = await rateRepo.fetch([stalePeerRate.id]);
    assert.ok(refreshedPeerRate);
    assert.equal(refreshedPeerRate.rate, 1.75);
    assert.equal(refreshedPeerRate.acquisitionMethod, 'PulledFromAse');
});

/**
 * TEST 5 - FX: ignorovanie udalostí, ktoré nemajú viesť k obnove.
 *
 * notifyExpiredFxRate má tri poistky:
 *  1. PushedByAse - kurz určila ASE, PAL ho nesmie prepísať sťahovaním,
 *  2. fresh - kurz bol načítaný neskôr, než prišlo oznámenie o expirácii,
 *  3. missing - neznámy rateId (napr. oneskorená správa) nesmie spadnúť.
 *
 * Overuje: ASE nebola zavolaná ani raz a nevznikli žiadne nové časovače.
 *
 * Test doubles: MockFxRepo (fake), StubAseFxService a
 * StubFxCacheExpiryService (stub).
 */
test('PAL Forex Domain - notifyExpiredFxRate ignores pushed, fresh and missing rates', async () => {
    const rateRepo = new MockFxRepo();
    const aseService = new StubAseFxService();
    const cacheExpiry = new StubFxCacheExpiryService();
    const aggregate = new FxAggregate(
        rateRepo,
        aseService,
        cacheExpiry,
        new NullLogger()
    );

    const pushedRate = new FxRate(
        'USD',
        'EUR',
        'PeerRate',
        'PushedByAse',
        PEER_ID,
        1.2,
        null,
        null
    );
    // fetchedAt 5000 je neskôr než notificationTime 4000 -> kurz je čerstvý.
    const freshRate = new FxRate(
        'USD',
        'EUR',
        'IntraAseRate',
        'PulledFromAse',
        null,
        1.3,
        5000,
        Date.now() + 100_000
    );
    await rateRepo.store(pushedRate.toDto());
    await rateRepo.store(freshRate.toDto());

    await aggregate.notifyExpiredFxRate(pushedRate.id, 10_000);
    await aggregate.notifyExpiredFxRate(freshRate.id, 4000);
    await aggregate.notifyExpiredFxRate('USD/CHF', Date.now());

    assert.equal(aseService.peerCalls.length + aseService.intraCalls.length, 0);
    assert.equal(cacheExpiry.setExpiryCalls.length, 0);
});

/**
 * TEST 6 - FX: výpadok ASE nesmie zhodiť spracovanie.
 *
 * Keď ASE zlyhá, getPeerFxRate/getIntraAseFxRate musia zalogovať error
 * a vrátiť null - o ďalšom postupe rozhodne volajúci.
 *
 * Test doubles:
 *  - StubAseFxService v režime fail = simulovaný výpadok,
 *  - RecordingLogger = spy na kontrolu errorov,
 *  - MockFxRepo = fake repozitár,
 *  - StubFxCacheExpiryService = stub.
 */
test('PAL Forex Domain - get rates returns null when ASE fails', async () => {
    const logger = new RecordingLogger();
    const aseService = new StubAseFxService(1, true);
    const aggregate = new FxAggregate(
        new MockFxRepo(),
        aseService,
        new StubFxCacheExpiryService(),
        logger
    );

    assert.equal(await aggregate.getPeerFxRate(PEER_ID, 'USD', 'EUR'), null);
    assert.equal(await aggregate.getIntraAseFxRate('USD', 'EUR'), null);
    assert.equal(logger.errors.length, 2);
});

/**
 * TEST 7 - LEDGER: vyčistenie in-memory stavu po rebalancii.
 *
 * LedgerAggregate drží ledger v pamäti, aby nemusel pri každom príkaze
 * čítať event-store. Pri rebalancii Kafky sa ledger môže presunúť na inú
 * inštanciu, takže táto inštancia musí pamäťovú kópiu zahodiť. Inak by
 * pracovala so starým stavom (zlé zostatky, dvojité rezervácie).
 *
 * requestInMemoryStateClear() len nastaví príznak; skutočné vyčistenie
 * prebehne na začiatku nasledujúceho processCommands().
 *
 * Test doubles:
 *  - MockLedgerEventSourcingRepository = fake event-store,
 *  - MockMessageProducer = fake producent,
 *  - MockTelemetryService = fake telemetria,
 */
test('PAL Ledger Domain - requestInMemoryStateClear drops cached ledgers', async () => {
    const messageStore: IMessage[] = [];
    const aggregate = new LedgerAggregate(
        new MockLedgerEventSourcingRepository(messageStore),
        new MockMessageProducer(messageStore),
        new NullLogger(),
        new MockTelemetryService()
    );

    await aggregate.processCommands(new CreateLedgerCmd({ id: 'EUR' }));
    assert.ok(await aggregate.getOrLoadLedger('EUR'));

    aggregate.requestInMemoryStateClear();
    await aggregate.processCommands(new CreateLedgerCmd({ id: 'USD' }));

    assert.equal(await aggregate.getOrLoadLedger('EUR'), null);
});

/**
 * TEST 8 - LEDGER: serializácia transakcie (BigInt <-> string).
 *
 * JSON nevie reprezentovať bigint, preto sa suma pri ukladaní prevádza
 * na string a pri načítaní späť na BigInt. Test overí obojsmerný prevod
 * vrátane nepovinných polí a príznakov, aby sa nestratila presnosť
 * ani význam transakcie (napr. že rezervácia ostane rezerváciou).
 */
test('PAL Ledger Domain - transaction serializer round trip', () => {
    const transfer: ILedgerTransaction = {
        id: 'tx-1',
        originatingCommandName: 'TestCmd',
        debitedAccountId: 'acc-a',
        creditedAccountId: 'acc-b',
        amount: 123n,
        amountScale: 2,
        timestamp: 42,
        externalId: 'ext-1',
        transferId: 'tr-1',
        isReservation: false,
        voidsReservation: true,
        peerId: PEER_ID
    };

    // BigInt sa do DTO uloží ako string, aby prešiel JSON serializáciou.
    const dto = LedgerTransactionDtoSerializer.toDTO(transfer);
    assert.equal(dto.amount, '123');
    assert.equal(dto.externalId, 'ext-1');

    // Spätný prevod musí vrátiť presne tie isté hodnoty.
    const restored = LedgerTransactionDtoSerializer.fromDTO(dto);
    assert.equal(restored.amount, 123n);
    assert.equal(restored.transferId, 'tr-1');
    assert.equal(restored.voidsReservation, true);
});