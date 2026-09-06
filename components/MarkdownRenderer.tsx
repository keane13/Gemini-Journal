'use client';

import React from 'react';
import Markdown from 'react-markdown';

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  return (
    <div className="prose max-w-none text-[var(--color-text-primary)] text-sm md:text-base leading-relaxed space-y-3 font-sans font-normal prose-headings:font-serif prose-headings:text-[var(--color-text-primary)] prose-headings:font-normal prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-p:text-[var(--color-text-primary)] prose-p:leading-relaxed prose-strong:text-[var(--color-text-primary)] prose-strong:font-semibold prose-li:text-[var(--color-text-primary)] prose-ul:list-disc prose-ol:list-decimal prose-code:text-[var(--color-accent)] prose-code:bg-[var(--color-surface)] prose-code:border prose-code:border-[var(--color-divider)] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:text-xs prose-pre:bg-[var(--color-surface)] prose-pre:border prose-pre:border-[var(--color-divider)] prose-pre:rounded-lg prose-blockquote:border-l-2 prose-blockquote:border-[var(--color-accent)] prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-[var(--color-text-secondary)]">
      <Markdown>{content}</Markdown>
    </div>
  );
};
