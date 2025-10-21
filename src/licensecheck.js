import  * as fs  from 'fs'
import { createCipheriv } from 'crypto';

let maxTries = 3
let currentTries = 3

function encryptTo8Digits(inputString, secretKey) {
  const iv = Buffer.alloc(16, 0)
  const key = Buffer.from(secretKey.padEnd(32, '0').slice(0, 32))
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(inputString), cipher.final()])
  const encryptedInt = BigInt(`0x${encrypted.toString('hex')}`)
  const eightDigitNumber = Number(encryptedInt % BigInt(10 ** 8))

  return String(eightDigitNumber).padStart(8, '0')
}

function decryptFrom8Digits(eightDigitNumber, inputString, secretKey) {
  const expectedEncrypted = encryptTo8Digits(inputString, secretKey);
  let match = false

  if (eightDigitNumber === expectedEncrypted) {
      match = true
  }

  return match
}

async function checkValidity() {
  
    const exp = await JSON.parse(fs.readFileSync('./config/.expiration.json'))


    let current = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    let valid = false

    if (current <= exp.date) {
      valid = true
    }
    return valid
}

async function testCode (codeToTest) {
  const exp = await JSON.parse(fs.readFileSync('./config/.expiration.json'))
  const theyear = (new Date().getFullYear()).toString()
  const userId = process.env.VIDEOSYSTEM_ID
  const decryptedString = decryptFrom8Digits(codeToTest, theyear, userId);
  let validCode = false

  if (decryptedString) {
    let temp = new Date().getFullYear()
    let temp2 = new Date()
    temp2.setFullYear(temp+1)
    exp.date = temp2.toISOString().slice(0, 10).replace(/-/g, '')
    fs.writeFile("./config/.expiration.json", JSON.stringify(exp), 'utf8', (err) => {
        if (err) {
            console.error('Error writing to file', err);
        } else {
            console.log('Data written to file');
        }
    });
    console.log("changed exp to: " + exp.date)
    validCode = true

  } else {
    currentTries-=1
  }

  return validCode
}


export { checkValidity, testCode }