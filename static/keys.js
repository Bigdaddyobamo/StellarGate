(function () {
  'use strict';

  var form = document.getElementById('signin-form');
  if (!form) {
    return;
  }

  var keyInput = document.getElementById('api-key');
  var errorEl = document.getElementById('signin-error');
  var submitBtn = document.getElementById('signin-submit');

  function clearError() {
    if (!errorEl) {
      return;
    }
    errorEl.textContent = '';
    errorEl.hidden = true;
    if (keyInput) {
      keyInput.removeAttribute('aria-invalid');
      keyInput.removeAttribute('aria-describedby');
    }
  }

  function showError(message) {
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
    if (keyInput) {
      keyInput.setAttribute('aria-invalid', 'true');
      if (errorEl && errorEl.id) {
        keyInput.setAttribute('aria-describedby', errorEl.id);
      }
      keyInput.focus();
    }
  }

  if (keyInput) {
    keyInput.addEventListener('input', clearError);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearError();

    var value = keyInput ? keyInput.value.trim() : '';
    if (!value) {
      showError('Please enter your API key.');
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
    }

    fetch('/api/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: value })
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Sign-in failed. Please check your API key and try again.');
        }
        window.location.reload();
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : 'Sign-in failed. Please try again.');
      })
      .then(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
        }
      });
  });
})();
