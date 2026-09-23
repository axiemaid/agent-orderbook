import {
    assert,
    ByteString,
    hash256,
    int2ByteString,
    method,
    prop,
    PubKey,
    PubKeyHash,
    Sig,
    SmartContract,
    toByteString,
    Utils,
} from 'scrypt-ts'

/**
 * ORD1 Bounty Covenant
 *
 * The simplest agent task market: sats locked with a task, anyone who
 * claims gets paid. No on-chain answer verification — quality is 100%
 * reputation layer.
 *
 * Same pattern as UTXO Organisms: UTXO sits on-chain, anyone who can
 * spend it correctly gets the reward. The "work" (computing an answer)
 * happens off-chain; the covenant just manages payment release.
 *
 * Two spending paths:
 *   1. claim()   — any agent signs, payment released to claimer
 *   2. timeout() — maker reclaims after expiry if nobody solved it
 *
 * The task/prompt is in the PLACE tx OP_RETURN (for indexer discovery),
 * NOT in the covenant script. The covenant only manages sats.
 *
 * OP_RETURN on PLACE tx:
 *   OP_FALSE OP_RETURN "ORD1" "BOUNTY" <type:1B> <reward:8B LE>
 *   <expiry:4B LE> <task:var>
 *
 * OP_RETURN on CLAIM tx:
 *   OP_FALSE OP_RETURN "ORD1" "CLAIM" <bounty_txid:32B> <answer:var>
 *
 * OP_RETURN on TIMEOUT tx:
 *   OP_FALSE OP_RETURN "ORD1" "TIMEOUT" <bounty_txid:32B>
 */

export class Bounty extends SmartContract {
    // Maker (buyer) — who posted the bounty, who can timeout
    @prop()
    makerPub: PubKey

    @prop()
    makerPkh: PubKeyHash

    // Block height after which maker can reclaim
    @prop()
    expiryHeight: bigint

    constructor(
        makerPub: PubKey,
        makerPkh: PubKeyHash,
        expiryHeight: bigint,
    ) {
        super(...arguments)
        this.makerPub = makerPub
        this.makerPkh = makerPkh
        this.expiryHeight = expiryHeight
    }

    /**
     * CLAIM — any agent claims the bounty
     *
     * The agent computed the answer off-chain. They submit a claim tx:
     *   - Sign with their own key (proves they want the payment)
     *   - Payment goes to their P2PKH
     *   - Answer is passed as a parameter (stored in input script, on-chain)
     *
     * No answer verification on-chain. Reputation layer handles quality:
     * garbage answers hurt the claimer's rep, future bounties filter by rep.
     *
     * The answer is in the unlocking script (input), NOT in the OP_RETURN.
     * This keeps the covenant's expected outputs fixed-size regardless of
     * answer length. Indexers extract the answer from the input script.
     *
     * Outputs:
     *   [0] Payment to claimer
     *   [1] OP_RETURN: ORD1 CLAIM (fixed)
     */
    @method()
    public claim(
        claimerPub: PubKey,
        claimerSig: Sig,
        claimerPkh: PubKeyHash,
        answer: ByteString,  // answer stored in input script, not verified
    ) {
        // Verify the claimer signed this transaction
        assert(this.checkSig(claimerSig, claimerPub), 'invalid claimer signature')

        // Payment to claimer (full UTXO value)
        let outputs: ByteString =
            Utils.buildPublicKeyHashOutput(claimerPkh, this.ctx.utxo.value)

        // OP_RETURN: ORD1 CLAIM (fixed, no variable data)
        const opReturnScript: ByteString =
            toByteString('006a') +
            toByteString('04') +
            toByteString('4f524431') +       // "ORD1"
            toByteString('05') +
            toByteString('434c41494d')       // "CLAIM"
        outputs += Utils.buildOutput(opReturnScript, 0n)

        assert(
            this.ctx.hashOutputs == hash256(outputs),
            'hashOutputs mismatch'
        )
    }

    /**
     * TIMEOUT — maker reclaims after expiry
     *
     * Nobody solved the bounty in time. Maker gets their sats back.
     *
     * Outputs:
     *   [0] Full refund to maker
     *   [1] OP_RETURN: ORD1 TIMEOUT
     */
    @method()
    public timeout(sig: Sig) {
        // Must be signed by maker
        assert(this.checkSig(sig, this.makerPub), 'invalid maker signature')

        // Must be past expiry
        assert(
            this.ctx.locktime >= this.expiryHeight,
            'bounty not yet expired'
        )

        // Full refund to maker
        let outputs: ByteString =
            Utils.buildPublicKeyHashOutput(this.makerPkh, this.ctx.utxo.value)

        // OP_RETURN: ORD1 TIMEOUT
        const opReturnScript: ByteString =
            toByteString('006a') +
            toByteString('04') +
            toByteString('4f524431') +       // "ORD1"
            toByteString('07') +
            toByteString('54494d454f5554')   // "TIMEOUT"
        outputs += Utils.buildOutput(opReturnScript, 0n)

        assert(
            this.ctx.hashOutputs == hash256(outputs),
            'hashOutputs mismatch'
        )
    }
}
