/**
 * Jarvis Arc Reactor / Audio Waveform visualizer.
 * Matches Iron Man HUD aesthetic with reactive sound-level pulsing.
 */

import React from 'react';
import type { VoiceState } from '../../types/voice';

interface VoiceWaveformProps {
  state: VoiceState;
  audioLevel: number; // 0.0 to 1.0
  className?: string;
}

export const VoiceWaveform: React.FC<VoiceWaveformProps> = ({
  state,
  audioLevel,
  className = '',
}) => {
  // Color palette based on Jarvis state
  let primaryColor = 'rgb(6, 182, 212)'; // Cyan
  let secondaryColor = 'rgba(6, 182, 212, 0.2)';
  let glowColor = 'rgba(6, 182, 212, 0.4)';

  if (state === 'WAKE_DETECTED') {
    primaryColor = 'rgb(245, 158, 11)'; // Amber gold
    secondaryColor = 'rgba(245, 158, 11, 0.25)';
    glowColor = 'rgba(245, 158, 11, 0.6)';
  } else if (state === 'RECORDING') {
    primaryColor = 'rgb(14, 165, 233)'; // Vivid sky blue
    secondaryColor = 'rgba(14, 165, 233, 0.3)';
    glowColor = 'rgba(14, 165, 233, 0.5)';
  } else if (state === 'PROCESSING' || state === 'TRANSCRIBING') {
    primaryColor = 'rgb(168, 85, 247)'; // Purple / AI compute
    secondaryColor = 'rgba(168, 85, 247, 0.25)';
    glowColor = 'rgba(168, 85, 247, 0.5)';
  } else if (state === 'SPEAKING') {
    primaryColor = 'rgb(56, 189, 248)'; // Arc electric
    secondaryColor = 'rgba(56, 189, 248, 0.3)';
    glowColor = 'rgba(56, 189, 248, 0.6)';
  } else if (state === 'MUTED') {
    primaryColor = 'rgb(239, 68, 68)'; // Red
    secondaryColor = 'rgba(239, 68, 68, 0.2)';
    glowColor = 'rgba(239, 68, 68, 0.4)';
  }

  // Generate 7 responsive audio bars
  const bars = [0.35, 0.6, 0.9, 1.0, 0.9, 0.6, 0.35];
  const scale = 0.2 + audioLevel * 1.6;

  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      {/* Outer ambient glow */}
      <div
        className="absolute inset-0 rounded-full blur-md transition-all duration-300"
        style={{
          background: glowColor,
          opacity: state === 'WAKE_LISTENING' ? 0.3 : 0.7 + audioLevel * 0.3,
          transform: `scale(${1 + audioLevel * 0.4})`,
        }}
      />

      {/* Outer rotating/pulsing ring */}
      <div
        className={`absolute h-10 w-10 rounded-full border border-dashed transition-all duration-300 ${
          state === 'PROCESSING' ? 'animate-spin' : ''
        }`}
        style={{
          borderColor: secondaryColor,
          transform: `scale(${1 + audioLevel * 0.25})`,
        }}
      />

      {/* Inner reactor core */}
      <div
        className="relative flex h-8 w-12 items-center justify-center gap-1 rounded-full px-1.5 transition-all duration-200"
        style={{
          background: 'rgba(15, 23, 42, 0.85)',
          border: `1px solid ${primaryColor}`,
          boxShadow: `0 0 10px ${glowColor}`,
        }}
      >
        {state === 'PROCESSING' || state === 'TRANSCRIBING' ? (
          // Rotating loader dots
          <div className="flex items-center gap-1">
            <span
              className="h-1.5 w-1.5 animate-bounce rounded-full"
              style={{ backgroundColor: primaryColor, animationDelay: '0ms' }}
            />
            <span
              className="h-1.5 w-1.5 animate-bounce rounded-full"
              style={{ backgroundColor: primaryColor, animationDelay: '150ms' }}
            />
            <span
              className="h-1.5 w-1.5 animate-bounce rounded-full"
              style={{ backgroundColor: primaryColor, animationDelay: '300ms' }}
            />
          </div>
        ) : (
          // Waveform bars
          bars.map((weight, index) => {
            const height = Math.max(
              3,
              state === 'WAKE_LISTENING'
                ? 3 + Math.sin(Date.now() / 400 + index) * 2
                : 3 + weight * scale * 16
            );
            return (
              <div
                key={index}
                className="w-0.5 rounded-full transition-all duration-75"
                style={{
                  height: `${height}px`,
                  backgroundColor: primaryColor,
                  opacity: state === 'MUTED' ? 0.4 : 0.85,
                }}
              />
            );
          })
        )}
      </div>
    </div>
  );
};
