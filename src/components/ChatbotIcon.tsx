import React from 'react';

interface ChatbotIconProps {
  className?: string;
}

export const ChatbotIcon: React.FC<ChatbotIconProps> = ({
  className = 'w-5 h-5',
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {/* Crisp rounded assistant chat bubble */}
    <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3h9A2.5 2.5 0 0 1 19 5.5v7A2.5 2.5 0 0 1 16.5 15H10l-4.2 3.5a.5.5 0 0 1-.8-.38V5.5Z" />
    {/* Friendly assistant eyes */}
    <line x1="9.5" y1="8.2" x2="9.5" y2="9.8" />
    <line x1="14.5" y1="8.2" x2="14.5" y2="9.8" />
    {/* Accent AI spark */}
    <path d="M19.5 17.5v3M18 19h3" />
  </svg>
);
