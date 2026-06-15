export interface FailedJob {
  document_id: string;
  filename: string;
  uploaded_at: string;
  error_message: string | null;
}

/**
 * Fields shared by every document-shaped payload the backend returns
 * (library listings, search results, and full document detail). Concrete
 * response types extend this with the extra fields specific to each endpoint.
 */
export interface DocumentBase {
  document_id: string;
  filename: string;
  title: string | null;
  category: string | null;
  tags: string[];
  document_date: string | null;
  uploaded_at: string;
  summary: string | null;
  has_thumbnail: boolean;
}
