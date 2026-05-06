const stepIds = ["home", "vehicle", "route", "confirm"];
const stepMeta = {
  home: {
    title: "Anything. Anyone. Instantly.",
    sub: "Fast local delivery with familiar map-first flow."
  },
  vehicle: {
    title: "Pick Your Ride Type",
    sub: "Lalamove-style flexibility with clear vehicle choices."
  },
  route: {
    title: "Confirm Route In Seconds",
    sub: "Uber-like 3-tap booking with minimal typing."
  },
  confirm: {
    title: "Book and Track Live",
    sub: "Bolt-style speed feel with real-time status confidence."
  }
};

const flowTitle = document.getElementById("flow-title");
const flowSub = document.getElementById("flow-sub");
const chosenVehicle = document.getElementById("chosen-vehicle");
const vehicleGrid = document.getElementById("vehicle-grid");

let activeStep = "home";
let selectedVehicle = "Bike";

function renderStep(step) {
  activeStep = step;
  stepIds.forEach((id) => {
    const el = document.getElementById(`step-${id}`);
    if (!el) return;
    el.classList.toggle("active", id === step);
  });

  flowTitle.textContent = stepMeta[step].title;
  flowSub.textContent = stepMeta[step].sub;
}

document.querySelectorAll("[data-next]").forEach((button) => {
  button.addEventListener("click", () => {
    renderStep(button.dataset.next);
  });
});

document.querySelectorAll("[data-back]").forEach((button) => {
  button.addEventListener("click", () => {
    renderStep(button.dataset.back);
  });
});

vehicleGrid.querySelectorAll(".vehicle").forEach((button) => {
  button.addEventListener("click", () => {
    vehicleGrid.querySelectorAll(".vehicle").forEach((node) => node.classList.remove("selected"));
    button.classList.add("selected");
    selectedVehicle = button.dataset.vehicle;
    chosenVehicle.textContent = selectedVehicle;
  });
});

document.querySelectorAll(".choice").forEach((button) => {
  button.addEventListener("click", () => {
    button.classList.toggle("selected");
  });
});

renderStep(activeStep);
