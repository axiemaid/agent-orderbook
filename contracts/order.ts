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
 * ORD1 Order Covenant
 *
 * A stateful covenant UTXO representing an open order on the ORD1 orderbook.
 * The order UTXO IS the order — it exists on-chain until filled, cancelled, or expired.
 *
 * Three spending paths:
 *   1. fill()   — any agent fills (partially or fully), payment to maker, remaining order continues
 *   2. cancel() — maker cancels after expiry (free) or pre-expiry (with penalty)
 *   3. timeout()— maker reclaims after expiry + grace period
 *
 * Stateful: partial fills create a new order UTXO with reduced remaining quantity.
 * Same pattern as ORG1 organism — spend creates continuation with updated state.
 *
 * OP_RETURN schema (on every spend):
 *   OP_FALSE OP_RETURN "ORD1" <action> <...action-specific fields>
 *
 * Constants:
 *   GRACE_BLOCKS = 144 (~24h after expiry_height)
 *   CANCEL_PENALTY_RATIO = 1% (100 basis points)
 */

// Side constants
const BID: bigint = 0n
const ASK: bigint = 1n

// Protocol constants
const GRACE_BLOCKS: bigint = 144n
const CANCEL_PENALTY_NUMERATOR: bigint = 1n
const CANCEL_PENALTY_DENOMINATOR: bigint = 100n

export class Order extends SmartContract {
    // Maker's public key — who placed the order, who can cancel/timeout
    @prop()
    makerPub: PubKey

    // Maker's P2PKH address hash — for payment verification
    @prop()
    makerPkh: PubKeyHash

    // Market type (0=COMPUTE, 1=DATA, 2=SERVICE, etc.)
    @prop()
    orderType: bigint

    // Side: BID (0) = buyer wants to buy, ASK (1) = seller wants to sell
    @prop()
    side: bigint

    // Price per unit in satoshis
    @prop()
    price: bigint

    // Block height after which cancel is free and timeout is possible
    @prop()
    expiryHeight: bigint

    // Remaining quantity (stateful — decreases on partial fills)
    @prop(true)
    remainingQuantity: bigint

    constructor(
        makerPub: PubKey,
        makerPkh: PubKeyHash,
        orderType: bigint,
        side: bigint,
        price: bigint,
        expiryHeight: bigint,
        remainingQuantity: bigint,
    ) {
        super(...arguments)
        this.makerPub = makerPub
        this.makerPkh = makerPkh
        this.orderType = orderType
        this.side = side
        this.price = price
        this.expiryHeight = expiryHeight
        this.remainingQuantity = remainingQuantity
    }

    /**
     * FILL — any agent matches the order (partially or fully)
     *
     * For ASK (seller): taker pays fillPrice >= order price → payment to maker
     * For BID (buyer): taker delivers, fillPrice <= order price → payment from locked order value to taker
     *
     * Partial fills: remaining quantity continues as new order UTXO (output 1)
     * Full fills: no continuation output
     *
     * Outputs:
     *   [0] Payment to maker (ASK) or to taker (BID) — fillPrice × fillQuantity
     *   [1] Remaining order UTXO (if partial fill, same covenant, reduced quantity)
     *   [2] OP_RETURN: ORD1 FILL receipt
     */
    @method()
    public fill(
        takerPkh: PubKeyHash,
        fillPrice: bigint,
        fillQuantity: bigint,
        // Whether this is a partial fill (determines if continuation output is needed)
        isPartial: boolean,
    ) {
        // Quantity must be positive and within remaining
        assert(fillQuantity > 0n, 'fill quantity must be positive')
        assert(fillQuantity <= this.remainingQuantity, 'fill exceeds remaining quantity')

        // Price constraints based on side
        if (this.side == ASK) {
            // ASK: buyer pays >= asking price
            assert(fillPrice >= this.price, 'fill price below ask price')
        } else {
            // BID: seller fulfills at <= bid price
            assert(fillPrice <= this.price, 'fill price above bid price')
        }

        // Calculate payment amount
        const paymentAmount: bigint = fillPrice * fillQuantity
        assert(paymentAmount > 0n, 'payment must be positive')

        // Update remaining quantity for continuation
        this.remainingQuantity = this.remainingQuantity - fillQuantity

        let outputs: ByteString = toByteString('')

        if (this.side == ASK) {
            // ASK: payment goes to maker (seller gets paid)
            outputs += Utils.buildPublicKeyHashOutput(this.makerPkh, paymentAmount)
        } else {
            // BID: payment goes to taker (seller claims from locked buyer funds)
            outputs += Utils.buildPublicKeyHashOutput(takerPkh, paymentAmount)
        }

        // Continuation output if partial fill
        if (isPartial) {
            // Remaining order value = price * remainingQuantity
            const remainingValue: bigint = this.price * this.remainingQuantity
            assert(remainingValue > 0n, 'remaining value must be positive')
            outputs += this.buildStateOutput(remainingValue)
        }

        // OP_RETURN: "ORD1" "FILL" <order_txid_ref:0s for now> <fillPrice:8B> <fillQuantity:8B>
        // Note: we can't reference our own txid in-script, so we use a placeholder
        // The indexer resolves the order txid from the input being spent
        const opReturnScript: ByteString =
            toByteString('006a') +                    // OP_FALSE OP_RETURN
            toByteString('04') +                       // push 4 bytes
            toByteString('4f524431') +                 // "ORD1"
            toByteString('04') +                       // push 4 bytes
            toByteString('46494c4c') +                 // "FILL"
            toByteString('08') +                       // push 8 bytes
            int2ByteString(fillPrice, 8n) +            // fill price LE
            toByteString('08') +                       // push 8 bytes
            int2ByteString(fillQuantity, 8n) +         // fill quantity LE
            toByteString('01') +                       // push 1 byte
            int2ByteString(this.orderType, 1n) +       // market type
            toByteString('01') +                       // push 1 byte
            int2ByteString(this.side, 1n)             // side
        outputs += Utils.buildOutput(opReturnScript, 0n)

        assert(
            this.ctx.hashOutputs == hash256(outputs),
            'hashOutputs mismatch'
        )
    }

    /**
     * CANCEL — maker cancels their own order
     *
     * Post-expiry: free cancel, full refund
     * Pre-expiry: cancel with penalty (1% of order value to burn/null)
     *
     * Outputs:
     *   [0] Refund to maker (order value minus penalty if pre-expiry)
     *   [1] Penalty output (if pre-expiry) — to OP_RETURN/burn
     *   [2] OP_RETURN: ORD1 CANCEL
     */
    @method()
    public cancel(sig: Sig) {
        // Must be signed by maker
        assert(this.checkSig(sig, this.makerPub), 'invalid maker signature')

        const orderValue: bigint = this.price * this.remainingQuantity

        let outputs: ByteString = toByteString('')

        if (this.ctx.locktime >= this.expiryHeight) {
            // Post-expiry: free cancel, full refund
            outputs += Utils.buildPublicKeyHashOutput(this.makerPkh, this.ctx.utxo.value)

            // OP_RETURN: ORD1 CANCEL
            const opReturnScript: ByteString =
                toByteString('006a') +
                toByteString('04') +
                toByteString('4f524431') +
                toByteString('06') +
                toByteString('43414e43454c')  // "CANCEL"
            outputs += Utils.buildOutput(opReturnScript, 0n)
        } else {
            // Pre-expiry: cancel with penalty
            // Penalty = orderValue * 1% = orderValue / 100
            // But we need to be careful with integer division
            const penalty: bigint = orderValue * CANCEL_PENALTY_NUMERATOR / CANCEL_PENALTY_DENOMINATOR
            const refundAmount: bigint = this.ctx.utxo.value - penalty
            assert(refundAmount > 0n, 'refund must be positive after penalty')

            // Refund to maker
            outputs += Utils.buildPublicKeyHashOutput(this.makerPkh, refundAmount)

            // Penalty to OP_RETURN (effectively burned)
            const burnScript: ByteString = toByteString('006a') + toByteString('00')  // OP_FALSE OP_RETURN OP_0
            outputs += Utils.buildOutput(burnScript, penalty)

            // OP_RETURN: ORD1 CANCEL
            const opReturnScript: ByteString =
                toByteString('006a') +
                toByteString('04') +
                toByteString('4f524431') +
                toByteString('06') +
                toByteString('43414e43454c')  // "CANCEL"
            outputs += Utils.buildOutput(opReturnScript, 0n)
        }

        assert(
            this.ctx.hashOutputs == hash256(outputs),
            'hashOutputs mismatch'
        )
    }

    /**
     * TIMEOUT — maker reclaims order value after expiry + grace period
     *
     * This is the safe reclaim path — no penalty, full refund.
     * Only available after expiryHeight + GRACE_BLOCKS.
     *
     * Outputs:
     *   [0] Full refund to maker
     *   [1] OP_RETURN: ORD1 TIMEOUT
     */
    @method()
    public timeout(sig: Sig) {
        // Must be signed by maker
        assert(this.checkSig(sig, this.makerPub), 'invalid maker signature')

        // Must be past grace period
        assert(
            this.ctx.locktime >= this.expiryHeight + GRACE_BLOCKS,
            'timeout not yet available — within grace period'
        )

        // Full refund
        let outputs: ByteString =
            Utils.buildPublicKeyHashOutput(this.makerPkh, this.ctx.utxo.value)

        // OP_RETURN: ORD1 TIMEOUT
        const opReturnScript: ByteString =
            toByteString('006a') +
            toByteString('04') +
            toByteString('4f524431') +
            toByteString('07') +
            toByteString('54494d454f5554')  // "TIMEOUT"
        outputs += Utils.buildOutput(opReturnScript, 0n)

        assert(
            this.ctx.hashOutputs == hash256(outputs),
            'hashOutputs mismatch'
        )
    }
}
