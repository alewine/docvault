export type FileBadgeConfig = {
  label: string;
  icon: string;
  colorClass: string;
};

export function getFileBadgeConfig(filename: string): FileBadgeConfig {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "pdf":
      return {
        label: "PDF",
        icon: "ti-file-type-pdf",
        colorClass: "badge-pdf",
      };
    case "jpg":
    case "jpeg":
      return { label: "JPG", icon: "ti-photo", colorClass: "badge-img" };
    case "png":
      return { label: "PNG", icon: "ti-photo", colorClass: "badge-img" };
    case "heic":
    case "heif":
      return { label: "HEIC", icon: "ti-camera", colorClass: "badge-img" };
    case "txt":
      return { label: "TXT", icon: "ti-file-text", colorClass: "badge-txt" };
    case "csv":
      return { label: "CSV", icon: "ti-table", colorClass: "badge-csv" };
    case "docx":
      return {
        label: "DOCX",
        icon: "ti-file-type-docx",
        colorClass: "badge-docx",
      };
    case "xlsx":
      return {
        label: "XLSX",
        icon: "ti-file-type-xls",
        colorClass: "badge-xlsx",
      };
    case "pptx":
      return {
        label: "PPTX",
        icon: "ti-presentation",
        colorClass: "badge-pptx",
      };
    case "mp3":
      return { label: "MP3", icon: "ti-music", colorClass: "badge-audio" };
    case "wav":
      return { label: "WAV", icon: "ti-music", colorClass: "badge-audio" };
    default:
      return {
        label: ext.toUpperCase() || "FILE",
        icon: "ti-file",
        colorClass: "badge-txt",
      };
  }
}
