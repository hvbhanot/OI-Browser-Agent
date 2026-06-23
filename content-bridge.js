window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "EXECUTE_PASTE") {
    window.dispatchEvent(
      new CustomEvent("START_PASTE_PROCESS", {
        detail: {
          data: event.data.data,
          contentType: event.data.contentType,
        },
      })
    );
  }
});