// content.js
function fillForm() {
  const textInputs = document.querySelectorAll('input[type="text"]');
  const paragraphs = document.querySelectorAll('textarea');
  const multipleChoice = document.querySelectorAll('div[role="radio"]');

  // Fill short answer
  textInputs.forEach(input => input.value = "John Doe");

  // Fill paragraph answers
  paragraphs.forEach(p => p.value = "This is a sample response.");

  // Randomly click a multiple choice option
  multipleChoice.forEach((radio, index) => {
    if (index % 3 === 0) radio.click();
  });

  alert("Form filled successfully ✅");
}

fillForm();
