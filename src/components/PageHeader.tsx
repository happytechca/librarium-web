// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 fireball1725

import { Fragment } from 'react'
import { Link } from 'react-router-dom'

export interface Crumb {
  label: string
  to?: string
}

interface PageHeaderProps {
  title: string
  description?: string
  breadcrumbs?: Crumb[]
  actions?: React.ReactNode
}

export default function PageHeader({ title, description, breadcrumbs, actions }: PageHeaderProps) {
  return (
    <div className="page-header sticky top-0 z-20 flex-shrink-0 bg-surface border-b border-line">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="flex items-center gap-2 text-sm flex-wrap mb-1" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="text-content-faint">/</span>}
              {crumb.to ? (
                <Link
                  to={crumb.to}
                  className="text-content-muted hover:text-content-secondary transition-colors"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-content-muted truncate max-w-xs">{crumb.label}</span>
              )}
            </Fragment>
          ))}
        </nav>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          {/* The display face earns its place on the page title and nowhere
              else in this component: chrome stays on the system stack. */}
          <h1 className="font-display text-2xl font-semibold text-content text-balance">{title}</h1>
          {description && (
            <p className="page-header-desc font-read mt-0.5 text-[15px] leading-snug text-content-muted max-w-[62ch]">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex-shrink-0 flex items-center gap-2 pt-0.5">{actions}</div>}
      </div>
    </div>
  )
}
