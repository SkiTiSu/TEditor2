import { Github } from 'lucide-react';

export function SiteCredits() {
  return (
    <span className="site-credits">
      <a
        href="https://github.com/SkiTiSu/TEditor2"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="TEditor2 GitHub 仓库"
        title="TEditor2 GitHub 仓库"
      >
        <Github size={15} aria-hidden="true" />
      </a>
      <span>© 2026 四季天书SkiTiSu</span>
    </span>
  );
}
