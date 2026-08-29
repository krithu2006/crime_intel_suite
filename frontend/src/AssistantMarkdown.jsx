import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders an AI Mitra assistant answer as formatted Markdown (GitHub-Flavored,
 * so tables/strikethrough/task lists work) instead of literal text. User
 * messages are never passed through this — they stay plain text.
 */
export default function AssistantMarkdown({ content }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h4 className="ai-md-heading">{children}</h4>,
          h2: ({ children }) => <h4 className="ai-md-heading">{children}</h4>,
          h3: ({ children }) => <h4 className="ai-md-heading">{children}</h4>,
          h4: ({ children }) => <h5 className="ai-md-heading ai-md-heading--sm">{children}</h5>,
          h5: ({ children }) => <h5 className="ai-md-heading ai-md-heading--sm">{children}</h5>,
          h6: ({ children }) => <h5 className="ai-md-heading ai-md-heading--sm">{children}</h5>,
          p: ({ children }) => <p className="ai-md-p">{children}</p>,
          strong: ({ children }) => <strong className="ai-md-strong">{children}</strong>,
          em: ({ children }) => <em className="ai-md-em">{children}</em>,
          ul: ({ children }) => <ul className="ai-md-list">{children}</ul>,
          ol: ({ children }) => <ol className="ai-md-list ai-md-list--ordered">{children}</ol>,
          li: ({ children }) => <li className="ai-md-list-item">{children}</li>,
          a: ({ href, children }) => (
            <a className="ai-md-link" href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
          code: ({ children }) => <code className="ai-md-code">{children}</code>,
          pre: ({ children }) => <pre className="ai-md-pre">{children}</pre>,
          table: ({ children }) => (
            <div className="ai-md-table-wrap"><table className="ai-md-table">{children}</table></div>
          ),
          thead: ({ children }) => <thead className="ai-md-thead">{children}</thead>,
          tr: ({ children }) => <tr className="ai-md-tr">{children}</tr>,
          th: ({ children }) => <th className="ai-md-th">{children}</th>,
          td: ({ children }) => <td className="ai-md-td">{children}</td>,
          blockquote: ({ children }) => <blockquote className="ai-md-blockquote">{children}</blockquote>,
          hr: () => <hr className="ai-md-hr" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
