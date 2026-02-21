import { useEffect, useState } from 'react'
import { api } from '../lib/client'
import { getCachedToken } from '../lib/auth'
import { Select } from './Select'
import { CopyAddressButton } from './CopyAddressButton'
import type { OnChainBalance, CryptoPricing } from '@shared/types'

const TIER_SPECS: Record<string, string> = {
  micro: '1 vCPU, 256 MB',
  small: '2 vCPU, 2 GB',
  medium: '2 vCPU perf, 4 GB',
  large: '4 vCPU perf, 8 GB',
}

const CHAIN_OPTIONS = [
  { value: 'base', label: 'Base' },
  { value: 'ethereum', label: 'Ethereum' },
  { value: 'arbitrum', label: 'Arbitrum' },
  { value: 'optimism', label: 'Optimism' },
  { value: 'polygon', label: 'Polygon' },
]

const TOKEN_OPTIONS = [
  { value: 'usdc', label: 'USDC' },
  { value: 'usdt', label: 'USDT' },
]

type ModalStep = 'loading-prices' | 'form' | 'confirm' | 'insufficient' | 'processing' | 'success' | 'error'

interface CryptoStationModalProps {
  roomId: number
  onClose: () => void
  onSuccess: () => void
  walletBalance: OnChainBalance | null
  walletAddress: string | null
}

export function CryptoStationModal({ roomId, onClose, onSuccess, walletBalance, walletAddress }: CryptoStationModalProps): React.JSX.Element {
  const [step, setStep] = useState<ModalStep>('loading-prices')
  const [tier, setTier] = useState('small')
  const [chain, setChain] = useState('base')
  const [token, setToken] = useState('usdc')
  const [pricing, setPricing] = useState<CryptoPricing | null>(null)
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')

  const selectedPrice = pricing?.tiers.find(t => t.tier === tier)?.cryptoPrice ?? 0

  // Fetch prices on modal open
  useEffect(() => {
    api.cloudStations.cryptoPrices(roomId)
      .then(p => { setPricing(p); setStep('form') })
      .catch(e => { setError((e as Error).message || 'Failed to fetch pricing'); setStep('error') })
  }, [roomId])

  function tierOptions() {
    return Object.entries(TIER_SPECS).map(([value, specs]) => {
      const price = pricing?.tiers.find(t => t.tier === value)?.cryptoPrice
      const priceStr = price != null ? ` — $${price}/mo` : ''
      return {
        value,
        label: `${value.charAt(0).toUpperCase() + value.slice(1)} (${specs})${priceStr}`,
      }
    })
  }

  function handleContinue(): void {
    if ((walletBalance?.totalBalance ?? 0) < selectedPrice) {
      setStep('insufficient')
    } else {
      setStep('confirm')
    }
  }

  async function handlePay(): Promise<void> {
    setStep('processing')
    const name = `station-${Date.now().toString(36)}`
    try {
      const result = await api.cloudStations.cryptoCheckout(roomId, {
        tier, name, chain, token,
      })
      setTxHash(result.txHash)
      setStep('success')
    } catch (e) {
      setError((e as Error).message || 'Checkout failed')
      setStep('error')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-text-muted hover:text-text-secondary text-lg leading-none transition-colors"
          aria-label="Close"
        >
          {'\u2715'}
        </button>

        <h2 className="text-lg font-bold text-text-primary mb-4">Add Station with Crypto</h2>

        {step === 'loading-prices' && (
          <div className="py-8 text-center">
            <div className="text-sm text-text-muted">Loading prices...</div>
          </div>
        )}

        {step === 'form' && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-text-secondary mb-1 block">Tier</label>
              <Select value={tier} onChange={setTier} options={tierOptions()} />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-text-secondary mb-1 block">Chain</label>
                <Select value={chain} onChange={setChain} options={CHAIN_OPTIONS} />
              </div>
              <div className="flex-1">
                <label className="text-xs text-text-secondary mb-1 block">Token</label>
                <Select value={token} onChange={setToken} options={TOKEN_OPTIONS} />
              </div>
            </div>
            <div className="bg-surface-secondary rounded-lg px-3 py-2 flex items-center justify-between">
              <span className="text-xs text-text-secondary">Wallet balance</span>
              <span className="text-sm font-semibold text-text-primary">${(walletBalance?.totalBalance ?? 0).toFixed(2)}</span>
            </div>
            <button
              onClick={handleContinue}
              className="w-full py-2.5 text-sm font-medium text-center text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors"
            >
              Continue
            </button>
          </div>
        )}

        {step === 'confirm' && pricing && (
          <div className="space-y-4">
            <div className="bg-surface-secondary rounded-lg p-3 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Tier</span>
                <span className="text-text-primary font-medium">{tier} ({TIER_SPECS[tier]})</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Price</span>
                <span className="text-text-primary font-medium">${selectedPrice.toFixed(2)}/mo</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Pay with</span>
                <span className="text-text-primary font-medium">{token.toUpperCase()} on {chain.charAt(0).toUpperCase() + chain.slice(1)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Balance</span>
                <span className="text-text-primary font-medium">${walletBalance?.totalBalance.toFixed(2) ?? '0.00'}</span>
              </div>
            </div>
            <button
              onClick={handlePay}
              className="w-full py-2.5 text-sm font-medium text-center text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors"
            >
              Pay ${selectedPrice.toFixed(2)} {token.toUpperCase()}
            </button>
            <button
              onClick={() => setStep('form')}
              className="w-full py-2 text-xs text-text-muted hover:text-text-secondary text-center"
            >
              Back
            </button>
          </div>
        )}

        {step === 'insufficient' && (() => {
          const addr = walletBalance?.address ?? walletAddress
          return (
            <div className="space-y-4">
              <div className="bg-status-warning-bg rounded-lg p-4 text-center">
                <div className="text-sm font-medium text-status-warning mb-1">Insufficient balance</div>
                <div className="text-xs text-text-muted">
                  You need <span className="font-semibold text-text-secondary">${selectedPrice.toFixed(2)}</span> but your wallet has <span className="font-semibold text-text-secondary">${walletBalance?.totalBalance.toFixed(2) ?? '0.00'}</span>.
                </div>
              </div>
              <a
                href={`/api/rooms/${roomId}/wallet/onramp-redirect?token=${encodeURIComponent(getCachedToken() ?? '')}&amount=${Math.ceil(selectedPrice - (walletBalance?.totalBalance ?? 0))}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full py-2.5 text-sm font-medium text-center bg-accent-primary text-white rounded-lg hover:bg-accent-hover no-underline"
              >
                Top Up from Card
              </a>
              <div className="text-[10px] text-text-muted text-center -mt-2">via Coinbase &middot; 0% fee &middot; USDC on Base</div>
              <div className="bg-surface-secondary rounded-lg p-4 space-y-2">
                <div className="text-xs font-medium text-text-primary">Or send crypto directly</div>
                <div className="text-xs text-text-muted leading-relaxed">
                  Send USDC or USDT on any supported chain (Base, Ethereum, Arbitrum, Optimism, Polygon) to the wallet address below. Balance updates automatically.
                </div>
                {addr && (
                  <div className="flex items-center gap-1 bg-surface-primary rounded-lg p-2.5 mt-2">
                    <span className="font-mono text-xs text-text-secondary truncate flex-1">{addr}</span>
                    <CopyAddressButton address={addr} />
                  </div>
                )}
              </div>
              <button
                onClick={() => setStep('form')}
                className="w-full py-2.5 text-sm font-medium text-center bg-surface-tertiary text-text-primary rounded-lg hover:bg-surface-hover"
              >
                Back
              </button>
            </div>
          )
        })()}

        {step === 'processing' && (
          <div className="py-8 text-center space-y-2">
            <div className="text-sm text-text-primary font-medium">Sending payment...</div>
            <div className="text-xs text-text-muted">This may take a moment while the transaction confirms.</div>
          </div>
        )}

        {step === 'success' && (
          <div className="space-y-4">
            <div className="bg-status-success-bg rounded-lg p-4 text-center">
              <div className="text-sm font-medium text-status-success mb-1">Station provisioned!</div>
              <div className="text-xs text-text-muted">Your station will be ready in ~30 seconds.</div>
            </div>
            {txHash && (
              <div className="text-xs text-text-muted text-center break-all">
                tx: {txHash}
              </div>
            )}
            <button
              onClick={onSuccess}
              className="w-full py-2.5 text-sm font-medium text-center text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-4">
            <div className="bg-status-error-bg rounded-lg p-4 text-center">
              <div className="text-sm font-medium text-status-error mb-1">Error</div>
              <div className="text-xs text-text-muted">{error}</div>
            </div>
            <button
              onClick={() => { setError(''); setStep('loading-prices') }}
              className="w-full py-2.5 text-sm font-medium text-center bg-surface-tertiary text-text-primary rounded-lg hover:bg-surface-hover"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
