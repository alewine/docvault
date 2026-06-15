const BACKEND_URL =
  typeof window !== "undefined"
    ? `http://${window.location.hostname}:8777`
    : "http://127.0.0.1:8777";

export default BACKEND_URL;
