const form = document.querySelector('#auth')
const password = document.querySelector('#password')
form.addEventListener('submit', async event => {
  event.preventDefault()
  const value = { username: document.querySelector('#username').value, password: password.value }
  password.value = ''
  try { await window.ezdAuth.submit(value) }
  catch { document.querySelector('#error').textContent = 'Nie udało się przesłać danych. Spróbuj ponownie.' }
  finally { value.password = '' }
})
document.querySelector('#cancel').addEventListener('click', () => window.ezdAuth.submit({ cancel: true }))
