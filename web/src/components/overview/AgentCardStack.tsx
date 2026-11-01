import { useState } from 'react';
import { AgentDto } from '../../types/api';
import { formatUsdFromMinor } from '../../lib/formatters';

interface AgentCardStackProps {
  agents: AgentDto[];
  className?: string;
}

/**
 * Metallic Gold EMV Chip SVG Icon
 * Matches the physical smart-card chip aesthetic from the design reference.
 */
function EmvChip({ className = 'w-9 h-7' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 38 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="EMV Smart Chip"
    >
      <rect
        x="0.5"
        y="0.5"
        width="37"
        height="27"
        rx="4.5"
        fill="url(#emv-gold-grad)"
        stroke="#9B7F39"
        strokeWidth="1"
      />
      {/* Circuit lines */}
      <path
        d="M0.5 14H37.5M13 0.5V27.5M25 0.5V27.5M13 14H25M0.5 7.5H13M0.5 20.5H13M25 7.5H37.5M25 20.5H37.5"
        stroke="#846B2C"
        strokeWidth="0.8"
        strokeOpacity="0.75"
      />
      <rect x="14.5" y="8.5" width="9" height="11" rx="2" fill="#D8B55B" fillOpacity="0.5" />
      <defs>
        <linearGradient id="emv-gold-grad" x1="0" y1="0" x2="38" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F5DC8C" />
          <stop offset="0.5" stopColor="#DFBC5D" />
          <stop offset="1" stopColor="#B38F36" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function AgentCardStack({ agents, className = '' }: AgentCardStackProps) {
  // Order of card indices: [backIndex, middleIndex, frontIndex]
  const [activeStack, setActiveStack] = useState<number[]>([2, 1, 0]);

  // Normalize agent slots (up to 3)
  const agentSlots = [
    agents[0] ?? null,
    agents[1] ?? null,
    agents[2] ?? null,
  ];

  const frontIndex = activeStack[2];
  const middleIndex = activeStack[1];
  const backIndex = activeStack[0];

  const activeAgent = agentSlots[frontIndex] ?? agentSlots.find(Boolean) ?? null;

  const handleCardClick = (slotIndex: number) => {
    if (slotIndex === frontIndex) return;
    setActiveStack((prev) => {
      const remaining = prev.filter((i) => i !== slotIndex);
      return [remaining[0], remaining[1], slotIndex];
    });
  };

  // Card configurations matching approved exact gradients:
  // Sage: #B8D99A → #A3C982
  // Lavender: #BBA9D8 → #A491C4
  // Peach: #E8B5A0 → #D49A84
  const cardStyles = [
    {
      gradient: 'linear-gradient(135deg, #B8D99A 0%, #A3C982 100%)',
      textColor: 'text-[#182613]',
      chipBorder: '#83A567',
      defaultLabel: 'Main Agent',
      defaultNumber: '6902',
    },
    {
      gradient: 'linear-gradient(135deg, #BBA9D8 0%, #A491C4 100%)',
      textColor: 'text-[#21192E]',
      chipBorder: '#8E7FB0',
      defaultLabel: 'Virtual Agent',
      defaultNumber: '4352',
    },
    {
      gradient: 'linear-gradient(135deg, #E8B5A0 0%, #D49A84 100%)',
      textColor: 'text-[#2A1B16]',
      chipBorder: '#B27D6B',
      defaultLabel: 'Savings Agent',
      defaultNumber: '3368',
    },
  ];

  const renderCard = (slotIndex: number, layer: 'back' | 'middle' | 'front') => {
    const agent = agentSlots[slotIndex];
    const style = cardStyles[slotIndex % cardStyles.length];
    const isUnregistered = !agent;

    let layerClasses = '';
    let topStyle = '';
    let zIndex = 10;

    if (layer === 'back') {
      layerClasses = 'mx-3 scale-[0.96] opacity-90 cursor-pointer hover:-translate-y-1';
      topStyle = '0px';
      zIndex = 10;
    } else if (layer === 'middle') {
      layerClasses = 'mx-1.5 scale-[0.98] opacity-95 cursor-pointer hover:-translate-y-1';
      topStyle = '38px';
      zIndex = 20;
    } else {
      layerClasses = 'w-full shadow-2xl';
      topStyle = '76px';
      zIndex = 30;
    }

    const lastFour = agent ? agent.id.replace(/[^a-zA-Z0-9]/g, '').slice(-4) : style.defaultNumber;
    const displayName = agent ? agent.name : `${style.defaultLabel} (Unregistered)`;

    return (
      <div
        key={`card-slot-${slotIndex}`}
        onClick={() => handleCardClick(slotIndex)}
        style={{
          background: isUnregistered ? 'linear-gradient(135deg, var(--unregistered-slot-from) 0%, var(--unregistered-slot-to) 100%)' : style.gradient,
          top: topStyle,
          zIndex,
        }}
        className={`absolute left-0 right-0 h-[168px] rounded-2xl p-4 transition-all duration-300 ease-out select-none border border-black/10 shadow-md ${layerClasses}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <EmvChip className="w-8 h-6" />
            <span
              className={`font-semibold tracking-tight text-sm truncate max-w-[120px] ${
                isUnregistered ? 'text-[var(--text-secondary)]' : style.textColor
              }`}
            >
              {displayName}
            </span>
          </div>
          <span
            className={`font-mono text-xs font-semibold tracking-wider ${
              isUnregistered ? 'text-[var(--text-muted)]' : style.textColor
            }`}
          >
            **** {lastFour}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div
      className={`relative rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 flex flex-col justify-between overflow-hidden transition-colors duration-200 ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between z-10">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-[var(--text-primary)]">Cards</span>
          <span className="text-xs font-semibold text-[var(--accent-sage)] align-super">3</span>
        </div>
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          {agents.length} {agents.length === 1 ? 'registered agent' : 'registered agents'}
        </span>
      </div>

      {/* Cards Viewport with Overlapping Geometry */}
      <div className="relative h-[252px] w-full mt-2">
        {renderCard(backIndex, 'back')}
        {renderCard(middleIndex, 'middle')}
        {renderCard(frontIndex, 'front')}

        {/* Frosted Bottom Information Panel Dock */}
        <div
          style={{
            background: 'linear-gradient(to top, var(--dock-from) 0%, var(--dock-via) 65%, transparent 100%)',
            borderTopColor: 'var(--dock-border)',
          }}
          className="absolute bottom-0 left-0 right-0 z-40 rounded-b-2xl backdrop-blur-md p-4 pt-6 border-t"
        >
          <div className="flex items-center justify-between">
            <p className="font-mono text-xs text-[var(--text-primary)] tracking-[0.25em] font-medium">
              •••• •••• •••• {activeAgent ? activeAgent.id.replace(/[^a-zA-Z0-9]/g, '').slice(-4) : '6902'}
            </p>
            <span className="text-[10px] uppercase font-mono tracking-wider px-1.5 py-0.5 rounded bg-[var(--elevated-bg)] border border-[var(--border-color)] text-[var(--text-secondary)]">
              {activeAgent?.status ?? 'STANDBY'}
            </span>
          </div>

          <div className="flex items-end justify-between mt-2.5">
            <div>
              <p className="text-xs font-medium text-[var(--text-primary)] truncate max-w-[140px]">
                {activeAgent?.name ?? 'No Agent Selected'}
              </p>
              <p className="text-[11px] text-[var(--text-secondary)]">
                {activeAgent ? `Daily Cap: ${formatUsdFromMinor(activeAgent.dailyBudgetMinor)}` : 'Slot Unregistered'}
              </p>
            </div>

            <div className="text-right">
              <span className="font-sans text-lg font-bold text-[var(--text-primary)] tracking-tight">
                {activeAgent ? formatUsdFromMinor(activeAgent.dailyBudgetMinor) : '$0.00'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
